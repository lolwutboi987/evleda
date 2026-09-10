import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { validateAndSnapshotEngineeringConstraintBinding } from "../engineering/constraint-compiler.js";
import type {
  CanonicalIdentity,
  ContentIdentity,
  RequirementsDocument,
} from "../domain/types.js";
import {
  FIRMWARE_PARITY_NATIVE_SOURCE_SCHEMA,
  deriveFirmwareParityNodes,
  firmwareParityMappingModel,
  firmwareParityMappingModelIdentity,
  type FirmwareParityNativeNode,
  type KicadNetlistNode
} from "../knowledge/firmware-parity-model.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
  REFERENCE_CONTROLLER_REV_A_REQUIRED_NATIVE_NETS,
  ReferenceControllerNativeContractError,
  reverifyReferenceControllerRevANativeAuthority,
  snapshotReferenceControllerRevANativeAuthority,
  type ReferenceControllerRevANativeAuthoritySnapshot,
} from "../knowledge/reference-controller-native-contract.js";
import {
  PCB_ENGINEERING_PRACTICE_CATALOG,
  validateAndSnapshotPcbEngineeringPracticeCatalog,
} from "../knowledge/pcb-engineering-practices.js";
import {
  createReferenceControllerProfile,
  REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
  REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
  REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_SCHEMA,
  ROBOTICS_CONTROLLER_V0,
  type ReferenceControllerParameters,
  type ReferenceControllerProfile,
} from "../knowledge/reference-controller-v0.js";
import type {
  KicadArtifactRole,
  KicadAnalyzerToolIdentity,
  KicadBackendReport,
  KicadBackendRequest,
  KicadBackendResult,
  KicadEvledaCheckReport,
  KicadEvledaCheckReportKind,
  KicadGeneratedArtifact,
  KicadGenerationBackend,
  KicadNativeReport,
  KicadNativeToolIdentity,
  KicadReportBinding,
  KicadReportInputBinding,
  KicadReportKind,
} from "../workflow/contracts.js";
import { buildKicadPcbEngineeringDecisionSummary } from "../workflow/contracts.js";
import {
  configuredKicadCliPath,
  KICAD_DESIGN_VIOLATIONS_EXIT_CODE,
  KicadCliAdapter,
  KicadCliError,
  KicadCliInvocationError,
  KicadSourceMutationError,
  type KicadCandidateArtifact,
  type KicadCandidateExportResult,
  type KicadCheckResult,
  type KicadCliInvocationEvidence,
  type KicadExecutableIdentity,
  type KicadNativeInspectionResult,
} from "./kicad-cli.js";
import {
  PathBoundaryError,
  assertDisjointDirectories,
  assertPathWithin,
  resolveConfinedExistingFile,
  resolveExistingDirectory,
  resolveExistingFile,
} from "./path-boundary.js";
import {
  PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
  analyzeKicadPcbPractices,
  type PcbPracticeAnalysis,
} from "./pcb-practice-analyzer.js";

export const REFERENCE_KICAD_BACKEND_ID = "evleda.reference-kicad.robotics-controller-v0.v2";
export const REFERENCE_KICAD_REPORT_SCHEMA = "evleda.reference-kicad-report.v2";
export const REFERENCE_KICAD_CAM_SCHEMA = "evleda.reference-kicad-cam-manifest.v1";
export const REFERENCE_KICAD_REQUEST_BINDING_SCHEMA = "evleda.reference-kicad-request-binding.v2";
export const REFERENCE_VALIDATION_SCHEMA = "evleda.reference-validation.v1";
export const REFERENCE_KICAD_VERSION = "10.0.3";
export const REFERENCE_PCB_FABRICATION_GEOMETRY_SCHEMA =
  "evleda.reference-pcb-fabrication-geometry.v1";
export const REFERENCE_CONNECTIVITY_ANALYZER_ID =
  "evleda.reference-kicad.connectivity.v2";
export const REFERENCE_PCB_PRACTICES_ANALYZER_ID =
  "evleda.reference-kicad.pcb-practices.v2";

export const REFERENCE_CONNECTIVITY_ANALYZER_TOOL: KicadAnalyzerToolIdentity = Object.freeze({
  name: "EvlEDA reference KiCad connectivity analyzer",
  version: "0.2.0",
  adapter: "evleda",
  capabilityProfile: REFERENCE_CONNECTIVITY_ANALYZER_ID,
});

const analyzerTool = (
  analyzerId: string,
  label: string,
): KicadAnalyzerToolIdentity =>
  Object.freeze({
    name: `EvlEDA reference KiCad ${label} analyzer`,
    version: "0.2.0",
    adapter: "evleda",
    capabilityProfile: analyzerId,
  });

export const REFERENCE_PCB_PRACTICES_ANALYZER_TOOL = analyzerTool(
  REFERENCE_PCB_PRACTICES_ANALYZER_ID,
  "PCB engineering practices",
);

export const REFERENCE_KICAD_ANALYZER_TOOLS = Object.freeze({
  connectivity: REFERENCE_CONNECTIVITY_ANALYZER_TOOL,
  schematic_parity: analyzerTool(
    "evleda.reference-kicad.schematic-parity.v2",
    "schematic parity",
  ),
  geometry: analyzerTool(
    "evleda.reference-kicad.fabrication-geometry.v2",
    "fabrication geometry",
  ),
  pcb_practices: REFERENCE_PCB_PRACTICES_ANALYZER_TOOL,
  bom_parity: analyzerTool("evleda.reference-kicad.bom-parity.v2", "BOM parity"),
  bom_export: analyzerTool("evleda.reference-kicad.bom-export.v2", "BOM export"),
  gerber_export: analyzerTool("evleda.reference-kicad.gerber-export.v2", "Gerber export"),
  drill_export: analyzerTool("evleda.reference-kicad.drill-export.v2", "drill export"),
  position_export: analyzerTool(
    "evleda.reference-kicad.position-export.v2",
    "position export",
  ),
  cam_manifest: analyzerTool(
    "evleda.reference-kicad.cam-manifest.v2",
    "CAM manifest",
  ),
} satisfies Readonly<Record<KicadEvledaCheckReportKind, KicadAnalyzerToolIdentity>>);

const REFERENCE_COPPER_LAYER_TABLE = Object.freeze([
  { id: 0, name: "F.Cu", type: "signal" },
  { id: 4, name: "In1.Cu", type: "signal" },
  { id: 6, name: "In2.Cu", type: "power" },
  { id: 8, name: "In3.Cu", type: "power" },
  { id: 10, name: "In4.Cu", type: "signal" },
  { id: 2, name: "B.Cu", type: "signal" },
] as const);
const REFERENCE_SIGNAL_LAYERS = Object.freeze(["F.Cu", "In1.Cu", "In4.Cu", "B.Cu"] as const);
const REFERENCE_MICROVIA_NET_COUNTS = Object.freeze({
  BOARD_ID0: 2,
  CAN_RX: 2,
  M1_DIR: 2,
  M1_FAULT: 2,
  M2_DIR: 2,
  M2_FAULT: 1,
});
const REFERENCE_STACKUP = Object.freeze([
  { name: "F.Cu", type: "copper", thickness: 0.035 },
  { name: "dielectric 1", type: "prepreg", thickness: 0.1, material: "FR-4", epsilonR: 4.29, lossTangent: 0.02 },
  { name: "In1.Cu", type: "copper", thickness: 0.035 },
  { name: "dielectric 2", type: "core", thickness: 0.54, material: "FR-4", epsilonR: 3.96, lossTangent: 0.02 },
  { name: "In2.Cu", type: "copper", thickness: 0.035 },
  { name: "dielectric 3", type: "prepreg", thickness: 0.11, material: "FR-4", epsilonR: 4.29, lossTangent: 0.02 },
  { name: "In3.Cu", type: "copper", thickness: 0.035 },
  { name: "dielectric 4", type: "core", thickness: 0.54, material: "FR-4", epsilonR: 3.96, lossTangent: 0.02 },
  { name: "In4.Cu", type: "copper", thickness: 0.035 },
  { name: "dielectric 5", type: "prepreg", thickness: 0.1, material: "FR-4", epsilonR: 4.29, lossTangent: 0.02 },
  { name: "B.Cu", type: "copper", thickness: 0.035 },
] as const);

const DESIGN_NAME = "robotics-controller-v0";
const REQUIRED_SOURCE_PATHS = Object.freeze([
  `${DESIGN_NAME}.kicad_pro`,
  `${DESIGN_NAME}.kicad_sch`,
  `${DESIGN_NAME}.kicad_pcb`,
  `${DESIGN_NAME}.kicad_dru`,
  "sym-lib-table",
  "fp-lib-table",
  "symbols/robotics_drv8874.kicad_sym",
  "symbols/robotics_lmr51420.kicad_sym",
  "symbols/robotics_sn74lvc2g17.kicad_sym",
  "symbols/robotics_tcan3413.kicad_sym",
  "symbols/robotics_tps2553.kicad_sym",
  "symbols/robotics_usb_c.kicad_sym",
  "symbols/robotics_usblc6.kicad_sym",
] as const);
const ALLOWED_ADDITIONAL_SOURCE_PATTERN =
  /^(?:symbols\/[a-z0-9_-]+\.kicad_sym|footprints\/[a-z0-9_-]+\.pretty\/[a-z0-9_.+-]+\.kicad_mod)$/iu;
export const REFERENCE_KICAD_GENERATOR_INPUT_PATHS = Object.freeze([
  "bom-engineering.csv",
  "design_data.py",
  "fabrication-capability-evidence.json",
  "fabrication-evidence/capture.json",
  "fabrication-evidence/pcbway-advanced-pcb-capabilities.excerpt.txt",
  "fabrication-evidence/pcbway-advanced-pcb-capabilities.html",
  "fabrication-evidence/pcbway-hdi-pcb.excerpt.txt",
  "fabrication-evidence/pcbway-hdi-pcb.html",
  "finalize_sixlayer_hdi.py",
  "generate_pcb.py",
  "generate_schematic.py",
  "prepare_sixlayer_hdi.py",
  "reference_component_metadata.py",
  "reference_generator_sources.py",
  "regeneration_receipt.py",
  "repair_routing.py",
  "route_in1.py",
  "routing-seed/open6-pcb-generation.json",
  "routing-seed/open6.kicad_pcb",
  "run_sixlayer_regeneration.py",
  "sixlayer-profile.json",
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
  "validate_reference.py",
  "write_sixlayer_regeneration_evidence.py",
] as const);
export const REFERENCE_KICAD_REPLAY_SCRIPT_PATHS = Object.freeze([
  "design_data.py",
  "finalize_sixlayer_hdi.py",
  "generate_pcb.py",
  "prepare_sixlayer_hdi.py",
  "repair_routing.py",
  "route_in1.py",
] as const);
export const REFERENCE_KICAD_REQUIRED_NETS =
  REFERENCE_CONTROLLER_REV_A_REQUIRED_NATIVE_NETS;
const QUALIFICATION_ONLY_ASSUMPTIONS = Object.freeze({
  PHYSICAL_QUALIFICATION_REQUIRED:
    "No fabricated board, bench measurements, thermal characterization, EMC test, or safety qualification exists.",
  MOTOR_RMS_LIMIT_FIRMWARE:
    "0.5 A RMS per motor channel is a firmware and thermal qualification limit; hardware implements only a nominal 1 A chop target.",
  HDI_FABRICATION_APPROVAL_REQUIRED:
    "Published advanced-HDI process limits do not approve this exact 1+4+1 stackup; laminate, impedance, 0.26/0.10 mm laser microvias, build notes, and CAM require written fabrication-engineering approval.",
} as const);
const EXPECTED_VALIDATION_INVOCATIONS = Object.freeze([
  ["00-version", ["version"]],
  ["01-commit", ["version", "--format", "commit"]],
  ["help-01", ["sch", "erc", "--help"]],
  ["help-02", ["pcb", "drc", "--help"]],
  ["help-03", ["sch", "export", "netlist", "--help"]],
  ["help-04", ["pcb", "export", "stats", "--help"]],
  ["help-05", ["pcb", "export", "ipcd356", "--help"]],
  ["help-06", ["sch", "export", "pdf", "--help"]],
  ["help-07", ["sch", "export", "bom", "--help"]],
  ["help-08", ["sch", "export", "svg", "--help"]],
  ["help-09", ["pcb", "export", "gerbers", "--help"]],
  ["help-10", ["pcb", "export", "drill", "--help"]],
  ["help-11", ["pcb", "export", "pos", "--help"]],
  ["help-12", ["pcb", "render", "--help"]],
  ["10-erc", ["sch", "erc"]],
  ["11-drc-parity", ["pcb", "drc"]],
  ["20-bom", ["sch", "export", "bom"]],
  ["21-netlist", ["sch", "export", "netlist"]],
  ["22-schematic-svg", ["sch", "export", "svg"]],
  ["23-schematic-pdf", ["sch", "export", "pdf"]],
  ["30-gerbers", ["pcb", "export", "gerbers"]],
  ["31-drill", ["pcb", "export", "drill"]],
  ["32-position", ["pcb", "export", "pos"]],
  ["33-render-top", ["pcb", "render"]],
  ["34-render-bottom", ["pcb", "render"]],
  ["35-board-stats", ["pcb", "export", "stats"]],
  ["36-board-ipcd356", ["pcb", "export", "ipcd356"]],
  ["37-board-svg-top", ["pcb", "export", "svg"]],
  ["38-board-svg-bottom", ["pcb", "export", "svg"]],
] as const);
const DEFAULT_REFERENCE_ROOT = path.resolve(
  process.cwd(),
  "reference-designs",
  DESIGN_NAME,
);
const JSON_MEDIA_TYPE = "application/json";
const TEXT_MEDIA_TYPE = "text/plain; charset=utf-8";

export type ReferenceKicadFailureCode =
  | "REFERENCE_REQUEST_INVALID"
  | "REFERENCE_PROFILE_UNSUPPORTED"
  | "REFERENCE_REQUIREMENTS_UNSUPPORTED"
  | "REFERENCE_SOURCE_UNAVAILABLE"
  | "REFERENCE_VALIDATION_MISSING"
  | "REFERENCE_VALIDATION_STALE"
  | "REFERENCE_TOOLCHAIN_UNAVAILABLE"
  | "REFERENCE_TOOLCHAIN_MISMATCH"
  | "REFERENCE_NATIVE_FINDINGS"
  | "REFERENCE_CONNECTIVITY_FAILED"
  | "REFERENCE_ROUTING_INCOMPLETE"
  | "REFERENCE_COMPONENT_METADATA_FAILED"
  | "REFERENCE_FABRICATION_GEOMETRY_FAILED"
  | "REFERENCE_BOM_PARITY_FAILED"
  | "REFERENCE_POSITION_PARITY_FAILED"
  | "REFERENCE_OUTPUT_MISSING"
  | "REFERENCE_SOURCE_MUTATED"
  | "REFERENCE_WORKSPACE_CLEANUP_FAILED"
  | "REFERENCE_BACKEND_INCONCLUSIVE";

export class ReferenceKicadBackendError extends DomainError {
  public constructor(
    public readonly failureCode: ReferenceKicadFailureCode,
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    retryable = false,
    options?: ErrorOptions,
  ) {
    super(code, message, { referenceKicadFailureCode: failureCode, ...details }, retryable);
    this.name = "ReferenceKicadBackendError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export interface ReferenceKicadBackendOptions {
  /** Explicit ordinary directory under which a fresh per-execution copy is created. */
  readonly workRoot: string;
  /** Defaults to the repository's fixed robotics-controller-v0 reference directory. */
  readonly referenceDesignRoot?: string;
  readonly executablePath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxReportBytes?: number;
  readonly signal?: AbortSignal;
}

interface FileBinding {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface ValidatedCanonicalReference {
  readonly referenceRoot: string;
  readonly validationPath: string;
  readonly validationIdentity: ContentIdentity;
  readonly validationDocument: Readonly<Record<string, unknown>>;
  readonly validationRoot: Readonly<Record<string, unknown>>;
  readonly nativeContractAuthority: ReferenceControllerRevANativeAuthoritySnapshot;
  readonly sourceBindings: readonly FileBinding[];
  readonly qualificationOnlyAssumptions: readonly Readonly<Record<string, unknown>>[];
  readonly regeneration: Readonly<Record<string, unknown>>;
  readonly snapshot: ReadonlyMap<string, FileBinding>;
}

interface WorkingCopy {
  readonly runRoot: string;
  readonly runDevice: number;
  readonly runInode: number;
  readonly projectRoot: string;
  readonly projectPath: string;
  readonly schematicPath: string;
  readonly pcbPath: string;
}

export interface ReferenceControllerElectricalEnvelopeBinding {
  readonly inputVoltageMv: {
    readonly minimum: number;
    readonly maximum: number;
  };
  readonly motor: {
    readonly channels: number;
    readonly rmsCurrentMaPerChannel: number;
    readonly currentChopMaPerChannel: number;
  };
}

export interface ReferenceControllerV0TemplateInstantiationBinding {
  readonly schemaVersion: typeof REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_SCHEMA;
  readonly identity: CanonicalIdentity;
  readonly mode: typeof REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE;
  readonly template: {
    readonly profileId: string;
    readonly boardRevision: string;
    readonly profileIdentity: CanonicalIdentity;
    readonly validatedElectricalEnvelope: ReferenceControllerElectricalEnvelopeBinding;
  };
  readonly requestedProfile: {
    readonly profileId: string;
    readonly boardRevision: string;
    readonly profileIdentity: CanonicalIdentity;
    readonly electricalEnvelope: ReferenceControllerElectricalEnvelopeBinding;
  };
  readonly reuse: {
    readonly structuralRelationship: "identical";
    readonly electricalEnvelopeRelationship: "requested-subset-of-template";
    readonly topologyGenerationPerformed: false;
    readonly nativeDesignMutationPerformed: false;
    readonly artifactSemantics: "validated-template-copy-not-newly-generated-pcb";
  };
}

export interface ReferenceKicadRequestBinding {
  readonly schemaVersion: typeof REFERENCE_KICAD_REQUEST_BINDING_SCHEMA;
  readonly identity: CanonicalIdentity;
  readonly request: {
    readonly schemaVersion: KicadBackendRequest["schemaVersion"];
    readonly stage: KicadBackendRequest["stage"];
    readonly expectedSourceRevisionDigest: string;
    readonly requirementsIdentity: CanonicalIdentity;
    readonly upstreamArtifactIdentities: readonly ContentIdentity[];
    readonly pcbEngineering: null | {
      readonly layoutPlan: {
        readonly logicalName: string;
        readonly contentIdentity: ContentIdentity;
      };
      readonly analyzerProfile: SnapshotReference;
      readonly practiceCatalog: SnapshotReference;
      readonly routeQualityPolicy: SnapshotReference & {
        readonly captureIdentity: ContentIdentity;
      };
      readonly routeQualityRuleDeck: SnapshotReference;
      readonly proofFixturePolicy: SnapshotReference;
      readonly engineeringConstraintBinding:
        | (SnapshotReference & { readonly compiledConstraintSetIdentity: CanonicalIdentity })
        | null;
    };
  };
  readonly templateInstantiation: ReferenceControllerV0TemplateInstantiationBinding;
}

interface SnapshotReference {
  readonly logicalName: string;
  readonly contentIdentity: ContentIdentity;
  readonly canonicalIdentity: CanonicalIdentity;
}

export interface ReferenceFirmwareParityPayload {
  readonly schemaVersion: typeof FIRMWARE_PARITY_NATIVE_SOURCE_SCHEMA;
  readonly nativeNodeLevel: true;
  readonly sourceRevisionDigest: string;
  readonly profileId: string;
  readonly boardRevision: string;
  readonly profileIdentity: CanonicalIdentity;
  readonly electricalEnvelope: ReferenceControllerElectricalEnvelopeBinding;
  readonly templateInstantiationMode: typeof REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE;
  readonly derivation: {
    readonly method: "kicad-netlist-nodes-plus-pinned-mcu-capabilities";
    readonly nativeNetlistIdentity: ContentIdentity;
    readonly mappingModelIdentity: ReturnType<typeof firmwareParityMappingModelIdentity>;
  };
  readonly nativeNodes: readonly FirmwareParityNativeNode[];
  readonly pins: typeof ROBOTICS_CONTROLLER_V0.pins;
  readonly resources: typeof ROBOTICS_CONTROLLER_V0.resources;
  readonly protocols: typeof ROBOTICS_CONTROLLER_V0.protocols;
}

interface ConnectivitySummary {
  readonly schematicReferences: readonly string[];
  readonly pcbReferences: readonly string[];
  readonly netNames: readonly string[];
  readonly schematicComponentCount: number;
  readonly pcbFootprintCount: number;
  readonly boardNetlistRecordCount: number;
  readonly schematicNetlistIdentity: ContentIdentity;
  readonly selectedComponents: {
    readonly schematic: readonly ReferenceSelectedComponentMetadata[];
    readonly pcb: readonly ReferenceSelectedComponentMetadata[];
  };
  readonly positionReferenceSource: PcbPositionReferenceSource;
  readonly firmwareParity: ReferenceFirmwareParityPayload;
}

export interface ReferenceSelectedComponentMetadata {
  readonly reference: string;
  readonly partNumber: string;
  readonly value: string;
  readonly footprint: string;
}

export interface ReferencePcbFabricationGeometry {
  readonly schemaVersion: typeof REFERENCE_PCB_FABRICATION_GEOMETRY_SCHEMA;
  readonly boardThicknessMm: number;
  readonly copperLayers: typeof REFERENCE_COPPER_LAYER_TABLE;
  readonly signalTrackCounts: Readonly<Record<string, number>>;
  readonly planes: {
    readonly ground: { readonly net: "GND"; readonly layer: "In2.Cu" };
    readonly power: { readonly net: "+3V3"; readonly layer: "In3.Cu" };
  };
  readonly vias: {
    readonly throughViaCount: number;
    readonly microviaCount: number;
    readonly microviaNetCounts: Readonly<Record<string, number>>;
    readonly diameterMm: 0.26;
    readonly drillMm: 0.1;
    readonly minimumAnnularWidthMm: 0.08;
    readonly layerPair: readonly ["F.Cu", "In1.Cu"];
  };
}

interface NativeComponentMetadata {
  readonly reference: string;
  readonly value: string | null;
  readonly footprint: string | null;
  readonly partNumber: string | null;
}

type PositionReferenceExclusionReason =
  | "do_not_populate"
  | "exclude_from_position_files"
  | "legacy_virtual";

interface NativePcbComponentMetadata extends NativeComponentMetadata {
  readonly positionExclusionReasons: readonly PositionReferenceExclusionReason[];
}

interface PcbPositionReferencePolicy {
  readonly side: "both";
  readonly excludeDnp: boolean;
  readonly smdOnly: false;
  readonly excludeFootprintsWithThroughHolePads: false;
  readonly pcbReferences: readonly string[];
  readonly pcbDnpReferences: readonly string[];
  readonly bomDnpReferences: readonly string[];
  readonly expectedPositionReferences: readonly string[];
  readonly deliberatelyExcludedReferences: readonly {
    readonly reference: string;
    readonly reasons: readonly PositionReferenceExclusionReason[];
  }[];
}

interface PcbPositionReferenceSource {
  readonly pcbReferences: readonly string[];
  readonly pcbDnpReferences: readonly string[];
  readonly footprintExcludedReferences: readonly {
    readonly reference: string;
    readonly reasons: readonly Exclude<PositionReferenceExclusionReason, "do_not_populate">[];
  }[];
}

interface PositionSummary {
  readonly references: readonly string[];
  readonly rowCount: number;
}

interface PositionExportSettings {
  readonly side: "both";
  readonly excludeDnp: boolean;
  readonly smdOnly: false;
  readonly excludeFootprintsWithThroughHolePads: false;
}

const PRODUCTION_POSITION_EXPORT_SETTINGS: PositionExportSettings = Object.freeze({
  side: "both",
  excludeDnp: true,
  smdOnly: false,
  excludeFootprintsWithThroughHolePads: false,
});

interface BomSummary {
  readonly references: readonly string[];
  readonly dnpReferences: readonly string[];
  readonly rowCount: number;
  readonly selectedComponents: readonly ReferenceSelectedComponentMetadata[];
}

interface ExecutionEvidence {
  readonly adapter: KicadCliAdapter;
  readonly canonical: ValidatedCanonicalReference;
  readonly working: WorkingCopy;
  readonly checks: KicadCheckResult;
  readonly inspection: KicadNativeInspectionResult;
  readonly exported?: KicadCandidateExportResult;
  readonly connectivity: ConnectivitySummary;
  readonly fabricationGeometry: ReferencePcbFabricationGeometry;
  readonly sourceBindings: readonly FileBinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function electricalEnvelope(
  profile: ReferenceControllerProfile,
): ReferenceControllerElectricalEnvelopeBinding {
  return {
    inputVoltageMv: {
      minimum: profile.inputVoltageMv.minimum,
      maximum: profile.inputVoltageMv.maximum,
    },
    motor: {
      channels: profile.motor.channels,
      rmsCurrentMaPerChannel: profile.motor.rmsCurrentMaPerChannel,
      currentChopMaPerChannel: profile.motor.currentChopMaPerChannel,
    },
  };
}

function templateInstantiationBinding(
  profile: ReferenceControllerProfile,
): ReferenceControllerV0TemplateInstantiationBinding {
  const preimage: Omit<ReferenceControllerV0TemplateInstantiationBinding, "identity"> = {
    schemaVersion: REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_SCHEMA,
    mode: REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
    template: {
      profileId: ROBOTICS_CONTROLLER_V0.profileId,
      boardRevision: ROBOTICS_CONTROLLER_V0.boardRevision,
      profileIdentity: canonicalIdentity(
        ROBOTICS_CONTROLLER_V0,
        REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
      ),
      validatedElectricalEnvelope: electricalEnvelope(ROBOTICS_CONTROLLER_V0),
    },
    requestedProfile: {
      profileId: profile.profileId,
      boardRevision: profile.boardRevision,
      profileIdentity: canonicalIdentity(profile, REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA),
      electricalEnvelope: electricalEnvelope(profile),
    },
    reuse: {
      structuralRelationship: "identical" as const,
      electricalEnvelopeRelationship: "requested-subset-of-template" as const,
      topologyGenerationPerformed: false as const,
      nativeDesignMutationPerformed: false as const,
      artifactSemantics: "validated-template-copy-not-newly-generated-pcb" as const,
    },
  };
  return {
    ...preimage,
    identity: canonicalIdentity(
      preimage,
      REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_SCHEMA,
    ),
  };
}

export function referenceKicadRequestBinding(
  request: KicadBackendRequest,
): ReferenceKicadRequestBinding {
  assertRequest(request);
  const snapshotReference = (snapshot: {
    readonly logicalName: string;
    readonly contentIdentity: ContentIdentity;
    readonly canonicalIdentity: CanonicalIdentity;
  }): SnapshotReference => ({
    logicalName: snapshot.logicalName,
    contentIdentity: structuredClone(snapshot.contentIdentity),
    canonicalIdentity: structuredClone(snapshot.canonicalIdentity),
  });
  const preimage: Omit<ReferenceKicadRequestBinding, "identity"> = {
    schemaVersion: REFERENCE_KICAD_REQUEST_BINDING_SCHEMA,
    request: {
      schemaVersion: request.schemaVersion,
      stage: request.stage,
      expectedSourceRevisionDigest: request.expectedSourceRevisionDigest,
      requirementsIdentity: structuredClone(request.requirements.identity),
      upstreamArtifactIdentities: structuredClone(request.upstreamArtifactIdentities),
      pcbEngineering:
        request.pcbEngineering === null
          ? null
          : {
              layoutPlan: {
                logicalName: request.pcbEngineering.layoutPlan.logicalName,
                contentIdentity: structuredClone(
                  request.pcbEngineering.layoutPlan.contentIdentity,
                ),
              },
              analyzerProfile: snapshotReference(request.pcbEngineering.analyzerProfile),
              practiceCatalog: snapshotReference(request.pcbEngineering.practiceCatalog),
              routeQualityPolicy: {
                ...snapshotReference(request.pcbEngineering.routeQualityPolicy),
                captureIdentity: structuredClone(
                  request.pcbEngineering.routeQualityPolicy.captureIdentity,
                ),
              },
              routeQualityRuleDeck: snapshotReference(
                request.pcbEngineering.routeQualityRuleDeck,
              ),
              proofFixturePolicy: snapshotReference(
                request.pcbEngineering.proofFixturePolicy,
              ),
              engineeringConstraintBinding:
                request.pcbEngineering.engineeringConstraintBinding === null
                  ? null
                  : {
                      ...snapshotReference(
                        request.pcbEngineering.engineeringConstraintBinding,
                      ),
                      compiledConstraintSetIdentity: structuredClone(
                        request.pcbEngineering.engineeringConstraintBinding.document
                          .compiledConstraintSetIdentity,
                      ),
                    },
            },
    },
    templateInstantiation: templateInstantiationBinding(request.profile),
  };
  return {
    ...preimage,
    identity: canonicalIdentity(preimage, REFERENCE_KICAD_REQUEST_BINDING_SCHEMA),
  };
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function duplicateStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return sortedUnique([...duplicates]);
}

function assertReferenceSetAgreement(options: {
  readonly observed: readonly string[];
  readonly expected: readonly string[];
  readonly relationship: "exact" | "observed_subset";
  readonly source: string;
  readonly expectedSource: string;
  readonly failureCode: ReferenceKicadFailureCode;
  readonly details?: Readonly<Record<string, unknown>>;
}): readonly string[] {
  const observed = sortedUnique(options.observed);
  const expected = sortedUnique(options.expected);
  const observedSet = new Set(observed);
  const expectedSet = new Set(expected);
  const duplicateObserved = duplicateStrings(options.observed);
  const duplicateExpected = duplicateStrings(options.expected);
  const missing = expected.filter((reference) => !observedSet.has(reference));
  const unexpected = observed.filter((reference) => !expectedSet.has(reference));
  const disagrees =
    duplicateObserved.length > 0 ||
    duplicateExpected.length > 0 ||
    unexpected.length > 0 ||
    (options.relationship === "exact" && missing.length > 0);
  if (disagrees) {
    throw new ReferenceKicadBackendError(
      options.failureCode,
      "GATE_FAILED",
      `${options.source} reference set does not satisfy ${options.expectedSource}.`,
      {
        relationship: options.relationship,
        source: options.source,
        expectedSource: options.expectedSource,
        observedReferences: observed,
        expectedReferences: expected,
        duplicateObservedReferences: duplicateObserved,
        duplicateExpectedReferences: duplicateExpected,
        missingReferences: missing,
        unexpectedReferences: unexpected,
        ...(options.details ?? {}),
      },
    );
  }
  return observed;
}

function normalizedLogicalPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isSafeLogicalPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

async function ordinaryFileBytes(
  filePath: string,
  label: string,
  allowEmpty = false,
): Promise<Buffer> {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_UNAVAILABLE",
      "TOOLCHAIN_UNAVAILABLE",
      `${label} must be a regular, non-symlink file.`,
      { path: filePath },
    );
  }
  const bytes = await readFile(filePath);
  if (!allowEmpty && bytes.byteLength === 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_UNAVAILABLE",
      "TOOLCHAIN_UNAVAILABLE",
      `${label} is empty.`,
      { path: filePath },
    );
  }
  return bytes;
}

async function regularFileBytes(filePath: string, label: string): Promise<Buffer> {
  return await ordinaryFileBytes(filePath, label);
}

async function bindingFor(
  filePath: string,
  relativePath: string,
  allowEmpty = false,
): Promise<FileBinding> {
  const bytes = await ordinaryFileBytes(
    filePath,
    `Reference file ${relativePath}`,
    allowEmpty,
  );
  const identity = contentIdentity(bytes);
  return { path: normalizedLogicalPath(relativePath), sizeBytes: identity.size, sha256: identity.digest };
}

function assertNativeContractFileBinding(
  binding: FileBinding,
  label: string,
  authority: ReferenceControllerRevANativeAuthoritySnapshot,
): void {
  const expected = authority.fileBinding;
  if (canonicalJson(binding) !== canonicalJson(expected)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "DIGEST_MISMATCH",
      `${label} does not bind the one imported native-contract authority.`,
      { expected, actual: binding },
    );
  }
}

function fileBindingFromRecord(value: unknown, allowEmpty = false): FileBinding | undefined {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.sha256 !== "string") {
    return undefined;
  }
  const size = value.sizeBytes ?? value.size;
  if (
    !isSafeLogicalPath(value.path) ||
    !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(size) ||
    (allowEmpty ? (size as number) < 0 : (size as number) <= 0)
  ) {
    return undefined;
  }
  return { path: value.path, sizeBytes: size as number, sha256: value.sha256 };
}

function collectFileBindingRecords(value: unknown, output: FileBinding[] = []): readonly FileBinding[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectFileBindingRecords(entry, output);
    return output;
  }
  if (!isRecord(value)) return output;
  const hasBindingShape =
    Object.hasOwn(value, "path") &&
    (Object.hasOwn(value, "sha256") ||
      Object.hasOwn(value, "sizeBytes") ||
      Object.hasOwn(value, "size"));
  if (hasBindingShape) {
    const binding = fileBindingFromRecord(value, true);
    if (binding === undefined) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_VALIDATION_STALE",
        "EVIDENCE_STALE",
        "Canonical validation contains a malformed file binding.",
      );
    }
    output.push(binding);
  }
  for (const entry of Object.values(value)) collectFileBindingRecords(entry, output);
  return output;
}

function assertZeroCount(
  object: Readonly<Record<string, unknown>>,
  candidateKeys: readonly string[],
  label: string,
): void {
  const key = candidateKeys.find((candidate) => Object.hasOwn(object, candidate));
  const value = key === undefined ? undefined : object[key];
  if (key === undefined || typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "EVIDENCE_STALE",
      `Canonical validation does not contain an integer ${label} count.`,
    );
  }
  if (value !== 0) {
    const routing = /route|unrouted/iu.test(label);
    throw new ReferenceKicadBackendError(
      routing ? "REFERENCE_ROUTING_INCOMPLETE" : "REFERENCE_NATIVE_FINDINGS",
      "GATE_FAILED",
      `Canonical validation reports ${value} ${label} findings.`,
      { key, count: value },
    );
  }
}

function checkRecord(manifest: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> {
  const value = manifest[name];
  if (!isRecord(value)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "EVIDENCE_STALE",
      `Canonical validation is missing its ${name} evidence object.`,
    );
  }
  return value;
}

function validationRootRecord(manifest: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!isRecord(manifest.validationRoot)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "EVIDENCE_STALE",
      "Canonical validation is missing validationRoot.",
    );
  }
  const root = manifest.validationRoot;
  if (
    root.algorithm !== "sha256" ||
    root.schemaVersion !== REFERENCE_VALIDATION_SCHEMA ||
    root.canonicalizationVersion !== "evleda-c14n-json-v1" ||
    typeof root.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(root.digest)
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "EVIDENCE_STALE",
      "Canonical validationRoot has an unsupported identity.",
    );
  }
  const payload = structuredClone(manifest) as Record<string, unknown>;
  delete payload.validationRoot;
  delete payload.createdAt;
  const recomputed = canonicalIdentity(payload, REFERENCE_VALIDATION_SCHEMA);
  if (recomputed.digest !== root.digest) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "DIGEST_MISMATCH",
      "Canonical validationRoot does not match the manifest's semantic content.",
      { expected: root.digest, actual: recomputed.digest },
    );
  }
  return root;
}

function staleValidation(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ReferenceKicadBackendError {
  return new ReferenceKicadBackendError(
    "REFERENCE_VALIDATION_STALE",
    "EVIDENCE_STALE",
    message,
    details,
  );
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en-US"));
  const normalizedExpected = [...expected].sort((left, right) => left.localeCompare(right, "en-US"));
  if (canonicalJson(actual) !== canonicalJson(normalizedExpected)) {
    throw staleValidation(`${label} has missing or unsupported fields.`, {
      expected: normalizedExpected,
      actual,
    });
  }
}

function safeStringArray(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    (!allowEmpty && value.length === 0)
  ) {
    throw staleValidation(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array of strings.`);
  }
  return value as readonly string[];
}

function integerField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
  minimum = 0,
): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum) {
    throw staleValidation(`${label} must contain integer ${key} >= ${minimum}.`);
  }
  return candidate as number;
}

function validateQualificationAssumptions(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    throw staleValidation("Canonical validation unresolvedAssumptions must be an array.");
  }
  const ids = new Set<string>();
  const qualificationOnly: Readonly<Record<string, unknown>>[] = [];
  const candidateBlocking: string[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.statement !== "string" ||
      !["information", "warning", "blocking"].includes(String(entry.severity)) ||
      entry.id.length === 0 ||
      entry.statement.length === 0 ||
      ids.has(entry.id)
    ) {
      throw staleValidation("Canonical validation contains a malformed or duplicate unresolved assumption.");
    }
    ids.add(entry.id);
    const expectedStatement =
      QUALIFICATION_ONLY_ASSUMPTIONS[
        entry.id as keyof typeof QUALIFICATION_ONLY_ASSUMPTIONS
      ];
    if (expectedStatement !== undefined) {
      if (
        entry.severity !== "blocking" ||
        entry.statement !== expectedStatement ||
        (entry.scope !== undefined && entry.scope !== "qualification")
      ) {
        throw staleValidation(
          `Qualification-only assumption ${entry.id} does not match its fixed v1 meaning.`,
        );
      }
      qualificationOnly.push({
        id: entry.id,
        severity: "blocking",
        scope: "qualification",
        statement: entry.statement,
      });
    } else if (entry.severity === "blocking") {
      candidateBlocking.push(entry.id);
    }
  }
  for (const requiredId of Object.keys(QUALIFICATION_ONLY_ASSUMPTIONS)) {
    if (!ids.has(requiredId)) {
      throw staleValidation(`Canonical validation omits qualification caveat ${requiredId}.`);
    }
  }
  if (candidateBlocking.length > 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_NATIVE_FINDINGS",
      "GATE_FAILED",
      "Canonical reference validation retains candidate-blocking assumptions.",
      { assumptionIds: candidateBlocking.sort((left, right) => left.localeCompare(right, "en-US")) },
    );
  }
  return qualificationOnly;
}

const REGENERATION_RECEIPT_SCHEMA = "evleda.sixlayer-regeneration-run-receipt.v2";
const REGENERATION_ISSUANCE_SCHEMA = "evleda.sixlayer-regeneration-issuance.v1";
const REGENERATION_INVENTORY_SCHEMA = "evleda.sixlayer-regeneration-root-inventory.v1";
const REGENERATION_EVIDENCE_SCHEMA = "evleda.reference-regeneration.v3";
const TRUSTED_KICAD_PYTHON_FILES = Object.freeze([
  { role: "launcher", identity: { algorithm: "sha256", digest: "f9e290b5d6d3bd0371ec842ac83f451d72d2b3e173ad745e221f7d839a66e953", size: 103_776 } },
  { role: "pcbnew_module", identity: { algorithm: "sha256", digest: "6b3f567f926bc219709c164c9286acce9c35d72e61e0172d59582fa8493471d1", size: 1_022_246 } },
  { role: "pcbnew_native", identity: { algorithm: "sha256", digest: "3ea2d4d26d928addfe1439698d355655a89fa1a17054cfba54805470052f6b83", size: 31_095_136 } },
] as const);
const RECEIPT_COMMAND_SPECS = Object.freeze([
  ["prepare", "kicad_python", [
    "tooling/prepare_sixlayer_hdi.py", "--input-board", "routing-seed/open6.kicad_pcb",
    "--schematic", "robotics-controller-v0.kicad_sch", "--output-board", "prepared.kicad_pcb",
    "--report", "preparation-report.json",
  ]],
  ["route", "kicad_python", [
    "tooling/route_in1.py", "--board", "prepared.kicad_pcb", "--report",
    "routing-seed/open6-pcb-generation.json", "--nets",
    "BOARD_ID0,M2_FAULT,M1_FAULT,M2_DIR,M1_DIR,CAN_RX", "--output-board",
    "routed.kicad_pcb", "--output-report", "route-stage-report.json",
  ]],
  ["finalize", "kicad_python", [
    "tooling/finalize_sixlayer_hdi.py", "--board", "routed.kicad_pcb", "--route-report",
    "route-stage-report.json", "--output-board", "robotics-controller-v0.kicad_pcb",
    "--output-report", "route-report.json", "--project", "robotics-controller-v0.kicad_pro",
  ]],
  ["erc", "kicad_cli", [
    "sch", "erc", "--format", "json", "--units", "mm", "--severity-all",
    "--exit-code-violations", "--output", "erc.json",
    "native-check/robotics-controller-v0.kicad_sch",
  ]],
  ["drc", "kicad_cli", [
    "pcb", "drc", "--schematic-parity", "--refill-zones", "--save-board", "--format",
    "json", "--units", "mm", "--severity-all", "--exit-code-violations", "--output",
    "drc.json", "native-check/robotics-controller-v0.kicad_pcb",
  ]],
] as const);
const RECEIPT_OUTPUT_PATHS = Object.freeze([
  "drc.json", "erc.json", "preparation-report.json", "prepared.kicad_pcb",
  "robotics-controller-v0.kicad_pcb", "robotics-controller-v0.kicad_pro",
  "route-report.json", "route-stage-report.json", "routed.kicad_pcb",
] as const);

function receiptContentIdentity(value: unknown, label: string): ContentIdentity {
  if (!isRecord(value)) throw staleValidation(`${label} is missing.`);
  assertExactKeys(value, ["algorithm", "digest", "size"], label);
  if (
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) <= 0
  ) {
    throw staleValidation(`${label} is not a valid non-empty content identity.`);
  }
  return value as unknown as ContentIdentity;
}

function validateReceiptSnapshot(
  value: unknown,
  expectedDigest: string,
  expectedBindings: readonly FileBinding[],
  label: string,
): readonly FileBinding[] {
  if (!isRecord(value)) throw staleValidation(`${label} is missing.`);
  assertExactKeys(value, ["digest", "bindings"], label);
  if (!Array.isArray(value.bindings)) throw staleValidation(`${label} bindings are missing.`);
  const bindings = value.bindings.map((entry) => directBinding(entry, `${label} binding`));
  const paths = bindings.map((entry) => entry.path);
  if (
    value.digest !== expectedDigest ||
    contentIdentity(canonicalJson(bindings)).digest !== expectedDigest ||
    canonicalJson(bindings) !== canonicalJson(expectedBindings) ||
    canonicalJson(paths) !== canonicalJson([...paths].sort((left, right) => left.localeCompare(right, "en-US"))) ||
    new Set(paths).size !== paths.length
  ) {
    throw staleValidation(`${label} is detached, unsorted, or incomplete.`);
  }
  return bindings;
}

function validateRunReceipt(
  value: unknown,
  sourceDigest: string,
  sourceBindings: readonly FileBinding[],
  generatorSourceDigest: string,
  generatorBindings: readonly FileBinding[],
  executable: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw staleValidation("Regeneration run receipt is missing.");
  assertExactKeys(value, [
    "schemaVersion", "runId", "nonce", "rootBinding", "lifecycle", "releaseAuthorized",
    "startedAt", "completedAt", "sourceSnapshot", "generatorSnapshot", "runInputs", "tools",
    "issuanceIdentity", "commands", "outputs", "native", "planner", "identity",
  ], "Regeneration run receipt");
  if (
    value.schemaVersion !== REGENERATION_RECEIPT_SCHEMA ||
    typeof value.runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.runId) ||
    typeof value.nonce !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.nonce) ||
    value.lifecycle !== "candidate" ||
    value.releaseAuthorized !== false ||
    typeof value.startedAt !== "string" ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    Date.parse(value.completedAt) < Date.parse(value.startedAt)
  ) {
    throw staleValidation("Regeneration run receipt identity, time, or candidate boundary is invalid.");
  }
  if (!isRecord(value.rootBinding)) throw staleValidation("Regeneration run root binding is missing.");
  assertExactKeys(value.rootBinding, ["pathDigest", "device", "inode", "ancestryDigests"], "Regeneration run root binding");
  const ancestryDigests = value.rootBinding.ancestryDigests;
  if (
    typeof value.rootBinding.pathDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.rootBinding.pathDigest) ||
    typeof value.rootBinding.device !== "string" ||
    !/^\d+$/u.test(value.rootBinding.device) ||
    typeof value.rootBinding.inode !== "string" ||
    !/^\d+$/u.test(value.rootBinding.inode) ||
    !Array.isArray(ancestryDigests) || ancestryDigests.length === 0 ||
    new Set(ancestryDigests).size !== ancestryDigests.length ||
    ancestryDigests.some((entry) => typeof entry !== "string" || !/^[0-9a-f]{64}$/u.test(entry)) ||
    ancestryDigests.includes(value.rootBinding.pathDigest)
  ) {
    throw staleValidation("Regeneration run root binding is malformed.");
  }
  const receiptSources = validateReceiptSnapshot(value.sourceSnapshot, sourceDigest, sourceBindings, "Receipt source snapshot");
  const receiptGenerators = validateReceiptSnapshot(value.generatorSnapshot, generatorSourceDigest, generatorBindings, "Receipt generator snapshot");
  if (!isRecord(value.issuanceIdentity)) throw staleValidation("Regeneration issuance identity is missing.");
  assertExactKeys(value.issuanceIdentity, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"], "Regeneration issuance identity");
  if (
    value.issuanceIdentity.algorithm !== "sha256" ||
    value.issuanceIdentity.schemaVersion !== REGENERATION_ISSUANCE_SCHEMA ||
    value.issuanceIdentity.canonicalizationVersion !== "evleda-c14n-json-v1" ||
    typeof value.issuanceIdentity.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.issuanceIdentity.digest)
  ) {
    throw staleValidation("Regeneration issuance identity is malformed.");
  }

  if (!Array.isArray(value.runInputs)) throw staleValidation("Regeneration run input bindings are missing.");
  const runInputs = value.runInputs.map((entry) => directBinding(entry, "Regeneration run input"));
  const runInputPaths = runInputs.map((entry) => entry.path);
  const expectedRunPaths = new Set(receiptSources.map((entry) => entry.path));
  for (const relativePath of REFERENCE_KICAD_REPLAY_SCRIPT_PATHS) expectedRunPaths.add(`tooling/${relativePath}`);
  expectedRunPaths.add("routing-seed/open6-pcb-generation.json");
  expectedRunPaths.add("routing-seed/open6.kicad_pcb");
  expectedRunPaths.add("writer-issuance.json");
  for (const source of receiptSources.filter((entry) => entry.path.startsWith("footprints/"))) {
    expectedRunPaths.add(`tooling/${source.path}`);
  }
  if (canonicalJson(runInputPaths) !== canonicalJson([...expectedRunPaths].sort((left, right) => left.localeCompare(right, "en-US")))) {
    throw staleValidation("Regeneration run input set is incomplete, reordered, duplicated, or open.");
  }
  const runInputMap = new Map(runInputs.map((entry) => [entry.path, entry]));
  const generatorMap = new Map(receiptGenerators.map((entry) => [entry.path, entry]));
  for (const source of receiptSources) {
    if (canonicalJson(runInputMap.get(source.path)) !== canonicalJson(source)) {
      throw staleValidation(`Regeneration run source copy is detached: ${source.path}.`);
    }
    if (source.path.startsWith("footprints/")) {
      const copy = { ...source, path: `tooling/${source.path}` };
      if (canonicalJson(runInputMap.get(copy.path)) !== canonicalJson(copy)) {
        throw staleValidation(`Regeneration tooling footprint is detached: ${source.path}.`);
      }
    }
  }
  for (const relativePath of REFERENCE_KICAD_REPLAY_SCRIPT_PATHS) {
    const generator = generatorMap.get(relativePath);
    const copy = generator === undefined ? undefined : { ...generator, path: `tooling/${relativePath}` };
    if (copy === undefined || canonicalJson(runInputMap.get(copy.path)) !== canonicalJson(copy)) {
      throw staleValidation(`Regeneration replay tool is detached: ${relativePath}.`);
    }
  }
  for (const relativePath of ["routing-seed/open6-pcb-generation.json", "routing-seed/open6.kicad_pcb"] as const) {
    if (canonicalJson(runInputMap.get(relativePath)) !== canonicalJson(generatorMap.get(relativePath))) {
      throw staleValidation(`Regeneration routing seed is detached: ${relativePath}.`);
    }
  }

  if (!isRecord(value.tools)) throw staleValidation("Regeneration receipt tools are missing.");
  assertExactKeys(value.tools, ["kicadPython", "kicadCli", "runner"], "Regeneration receipt tools");
  const pythonTool = isRecord(value.tools.kicadPython) ? value.tools.kicadPython : undefined;
  const cliTool = isRecord(value.tools.kicadCli) ? value.tools.kicadCli : undefined;
  const runner = isRecord(value.tools.runner) ? value.tools.runner : undefined;
  if (pythonTool === undefined || cliTool === undefined || runner === undefined) {
    throw staleValidation("Regeneration receipt tool identities are incomplete.");
  }
  assertExactKeys(pythonTool, ["kind", "version", "pcbnewVersion", "files"], "KiCad Python receipt tool");
  if (
    pythonTool.kind !== "kicad-python" ||
    typeof pythonTool.version !== "string" ||
    pythonTool.pcbnewVersion !== REFERENCE_KICAD_VERSION ||
    !Array.isArray(pythonTool.files) ||
    canonicalJson(pythonTool.files.map((entry) => isRecord(entry) ? entry.role : null)) !==
      canonicalJson(["launcher", "pcbnew_module", "pcbnew_native"])
  ) {
    throw staleValidation("KiCad Python receipt tool identity is unsupported.");
  }
  for (const entry of pythonTool.files) {
    if (!isRecord(entry)) throw staleValidation("KiCad Python receipt file identity is malformed.");
    assertExactKeys(entry, ["role", "identity"], "KiCad Python receipt file");
    receiptContentIdentity(entry.identity, "KiCad Python receipt file identity");
  }
  if (canonicalJson(pythonTool.files) !== canonicalJson(TRUSTED_KICAD_PYTHON_FILES)) {
    throw staleValidation("KiCad Python receipt tool differs from the pinned installed closure.");
  }
  assertExactKeys(cliTool, ["kind", "version", "commit", "contentIdentity", "capabilityHelpSha256"], "KiCad CLI receipt tool");
  if (
    cliTool.kind !== "kicad-cli" || cliTool.version !== REFERENCE_KICAD_VERSION ||
    typeof cliTool.commit !== "string" || !/^[0-9a-f]{40}$/u.test(cliTool.commit) ||
    typeof cliTool.capabilityHelpSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(cliTool.capabilityHelpSha256)
  ) {
    throw staleValidation("KiCad CLI receipt tool identity is unsupported.");
  }
  receiptContentIdentity(cliTool.contentIdentity, "KiCad CLI receipt content identity");
  const executableContentIdentity = {
    algorithm: "sha256",
    digest: executable.sha256,
    size: executable.sizeBytes,
  };
  if (
    cliTool.version !== executable.version || cliTool.commit !== executable.commit ||
    cliTool.capabilityHelpSha256 !== executable.capabilityHelpSha256 ||
    canonicalJson(cliTool.contentIdentity) !== canonicalJson(executableContentIdentity)
  ) {
    throw staleValidation("KiCad CLI receipt tool differs from the manifest-pinned installed closure.");
  }
  assertExactKeys(runner, ["kind", "logicalName", "contentIdentity"], "Regeneration receipt runner");
  const runnerIdentity = receiptContentIdentity(runner.contentIdentity, "Regeneration receipt runner identity");
  const runnerBinding = generatorMap.get("run_sixlayer_regeneration.py");
  if (
    runner.kind !== "host-receipt-runner" || runner.logicalName !== "run_sixlayer_regeneration.py" ||
    runnerBinding === undefined || runnerBinding.sha256 !== runnerIdentity.digest || runnerBinding.sizeBytes !== runnerIdentity.size
  ) {
    throw staleValidation("Regeneration receipt runner is detached from the generator snapshot.");
  }

  if (!Array.isArray(value.commands) || value.commands.length !== RECEIPT_COMMAND_SPECS.length) {
    throw staleValidation("Regeneration receipt command set is incomplete.");
  }
  let priorCompletion = Date.parse(value.startedAt);
  for (const [zeroIndex, [operation, tool, args]] of RECEIPT_COMMAND_SPECS.entries()) {
    const command = value.commands[zeroIndex];
    if (!isRecord(command)) throw staleValidation(`Regeneration command ${operation} is malformed.`);
    assertExactKeys(command, [
      "sequence", "operation", "commandId", "tool", "arguments", "startedAt", "completedAt",
      "durationMs", "exitCode", "stdout", "stderr",
    ], `Regeneration command ${operation}`);
    const sequence = zeroIndex + 1;
    const expectedCommandId = contentIdentity(`${value.nonce}\0${sequence.toString()}\0${operation}`).digest;
    const startedAt = typeof command.startedAt === "string" ? Date.parse(command.startedAt) : Number.NaN;
    const completedAt = typeof command.completedAt === "string" ? Date.parse(command.completedAt) : Number.NaN;
    if (
      command.sequence !== sequence || command.operation !== operation || command.tool !== tool ||
      canonicalJson(command.arguments) !== canonicalJson(args) || command.commandId !== expectedCommandId ||
      command.exitCode !== 0 || !Number.isSafeInteger(command.durationMs) || (command.durationMs as number) < 0 ||
      !Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt < priorCompletion ||
      completedAt < startedAt || completedAt > Date.parse(value.completedAt)
    ) {
      throw staleValidation(`Regeneration command ${operation} is failed, detached, or out of order.`);
    }
    const stdout = directBinding(command.stdout, `Regeneration command ${operation} stdout`, true);
    const stderr = directBinding(command.stderr, `Regeneration command ${operation} stderr`, true);
    if (
      stdout.path !== `receipt-logs/${sequence.toString().padStart(2, "0")}-${operation}.stdout.txt` ||
      stderr.path !== `receipt-logs/${sequence.toString().padStart(2, "0")}-${operation}.stderr.txt`
    ) {
      throw staleValidation(`Regeneration command ${operation} transcript paths are not canonical.`);
    }
    priorCompletion = completedAt;
  }

  if (!Array.isArray(value.outputs)) throw staleValidation("Regeneration receipt outputs are missing.");
  const outputs = value.outputs.map((entry) => directBinding(entry, "Regeneration receipt output"));
  if (canonicalJson(outputs.map((entry) => entry.path)) !== canonicalJson(RECEIPT_OUTPUT_PATHS)) {
    throw staleValidation("Regeneration receipt output set is incomplete or reordered.");
  }
  const outputMap = new Map(outputs.map((entry) => [entry.path, entry]));
  if (!isRecord(value.native) || !isRecord(value.native.erc) || !isRecord(value.native.drc)) {
    throw staleValidation("Regeneration native receipt evidence is missing.");
  }
  assertExactKeys(value.native, ["erc", "drc"], "Regeneration native receipt evidence");
  assertExactKeys(value.native.erc, ["report", "violationCount"], "Regeneration ERC receipt evidence");
  assertExactKeys(value.native.drc, ["report", "violationCount", "unconnectedCount", "schematicParityCount"], "Regeneration DRC receipt evidence");
  if (
    canonicalJson(directBinding(value.native.erc.report, "Regeneration ERC receipt report")) !== canonicalJson(outputMap.get("erc.json")) ||
    canonicalJson(directBinding(value.native.drc.report, "Regeneration DRC receipt report")) !== canonicalJson(outputMap.get("drc.json")) ||
    value.native.erc.violationCount !== 0 || value.native.drc.violationCount !== 0 ||
    value.native.drc.unconnectedCount !== 0 || value.native.drc.schematicParityCount !== 0
  ) {
    throw staleValidation("Regeneration native receipt evidence is non-passing or detached.");
  }
  if (!isRecord(value.planner)) throw staleValidation("Regeneration planner receipt evidence is missing.");
  assertExactKeys(value.planner, ["partialRouteCount", "unresolvedConnectionCount", "nativeUnconnectedCount"], "Regeneration planner receipt evidence");
  if (Object.values(value.planner).some((entry) => entry !== 0)) {
    throw staleValidation("Regeneration planner receipt evidence is non-passing.");
  }

  if (!isRecord(value.identity)) throw staleValidation("Regeneration receipt identity is missing.");
  assertExactKeys(value.identity, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"], "Regeneration receipt identity");
  const payload = structuredClone(value) as Record<string, unknown>;
  delete payload.identity;
  if (
    value.identity.algorithm !== "sha256" || value.identity.schemaVersion !== REGENERATION_RECEIPT_SCHEMA ||
    value.identity.canonicalizationVersion !== "evleda-c14n-json-v1" ||
    canonicalJson(value.identity) !== canonicalJson(canonicalIdentity(payload, REGENERATION_RECEIPT_SCHEMA))
  ) {
    throw staleValidation("Regeneration receipt identity does not reproduce its exact payload.");
  }
  return value;
}

async function retainedReceiptBytes(
  referenceRoot: string,
  value: unknown,
  label: string,
  allowEmpty = false,
): Promise<{ readonly binding: FileBinding; readonly bytes: Buffer }> {
  const binding = directBinding(value, label, allowEmpty);
  const filePath = await resolveConfinedExistingFile(referenceRoot, referenceRoot, binding.path, label);
  const bytes = await ordinaryFileBytes(filePath, label, allowEmpty);
  const actual = contentIdentity(bytes);
  if (actual.digest !== binding.sha256 || actual.size !== binding.sizeBytes) {
    throw staleValidation(`${label} retained bytes do not reproduce their binding.`);
  }
  return { binding, bytes };
}

function parsedRetainedJson(bytes: Buffer, label: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw staleValidation(`${label} is not valid UTF-8 JSON.`);
  }
  if (!isRecord(value)) throw staleValidation(`${label} JSON root is not an object.`);
  return value;
}

function validateRetainedIssuance(
  value: unknown,
  receipt: Readonly<Record<string, unknown>>,
  generatorBindings: readonly FileBinding[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw staleValidation("Retained writer issuance is missing.");
  assertExactKeys(value, [
    "schemaVersion", "issuanceId", "challenge", "issuedAt", "rootBinding",
    "writerIdentity", "identity",
  ], "Retained writer issuance");
  if (
    value.schemaVersion !== REGENERATION_ISSUANCE_SCHEMA ||
    typeof value.issuanceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.issuanceId) ||
    value.challenge !== receipt.nonce ||
    typeof value.issuedAt !== "string" || !Number.isFinite(Date.parse(value.issuedAt)) ||
    Date.parse(value.issuedAt) > Date.parse(receipt.startedAt as string) ||
    canonicalJson(value.rootBinding) !== canonicalJson(receipt.rootBinding)
  ) {
    throw staleValidation("Retained writer issuance does not precede and bind its receipt.");
  }
  const writerIdentity = receiptContentIdentity(value.writerIdentity, "Retained writer source identity");
  const writerBinding = generatorBindings.find((entry) => entry.path === "write_sixlayer_regeneration_evidence.py");
  if (
    writerBinding === undefined || writerBinding.sha256 !== writerIdentity.digest ||
    writerBinding.sizeBytes !== writerIdentity.size
  ) {
    throw staleValidation("Retained writer issuance differs from the generator-bound writer source.");
  }
  if (!isRecord(value.identity)) throw staleValidation("Retained writer issuance identity is missing.");
  const payload = structuredClone(value) as Record<string, unknown>;
  delete payload.identity;
  if (
    canonicalJson(value.identity) !== canonicalJson(canonicalIdentity(payload, REGENERATION_ISSUANCE_SCHEMA)) ||
    canonicalJson(value.identity) !== canonicalJson(receipt.issuanceIdentity)
  ) {
    throw staleValidation("Retained writer issuance identity is detached.");
  }
  return value;
}

function validateRetainedInventory(
  value: unknown,
  receipt: Readonly<Record<string, unknown>>,
  issuance: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw staleValidation("Retained root inventory is missing.");
  assertExactKeys(value, [
    "schemaVersion", "runId", "rootBinding", "issuanceIdentity", "receiptIdentity",
    "files", "identity",
  ], "Retained root inventory");
  if (
    value.schemaVersion !== REGENERATION_INVENTORY_SCHEMA || value.runId !== receipt.runId ||
    canonicalJson(value.rootBinding) !== canonicalJson(receipt.rootBinding) ||
    canonicalJson(value.issuanceIdentity) !== canonicalJson(issuance.identity) ||
    canonicalJson(value.receiptIdentity) !== canonicalJson(receipt.identity) ||
    !Array.isArray(value.files)
  ) {
    throw staleValidation("Retained root inventory is detached from its issuance or receipt.");
  }
  const files = (value.files as readonly unknown[]).map((entry) =>
    directBinding(entry, "Retained root inventory file", true)
  );
  const paths = files.map((entry) => entry.path);
  if (
    canonicalJson(paths) !== canonicalJson([...paths].sort((left, right) => left.localeCompare(right, "en-US"))) ||
    new Set(paths).size !== paths.length
  ) {
    throw staleValidation("Retained root inventory paths are not sorted and unique.");
  }
  const expected = new Map<string, FileBinding>();
  for (const entry of [
    ...(receipt.runInputs as readonly unknown[]),
    ...(receipt.outputs as readonly unknown[]),
  ]) {
    const binding = directBinding(entry, "Receipt inventory member", true);
    expected.set(binding.path, binding);
  }
  for (const command of receipt.commands as readonly Readonly<Record<string, unknown>>[]) {
    for (const stream of ["stdout", "stderr"] as const) {
      const binding = directBinding(command[stream], "Receipt transcript inventory member", true);
      expected.set(binding.path, binding);
    }
  }
  const receiptFile = files.find((entry) => entry.path === "regeneration-run-receipt.json");
  if (receiptFile === undefined) throw staleValidation("Retained root inventory omits raw receipt bytes.");
  expected.set(receiptFile.path, receiptFile);
  if (canonicalJson(files) !== canonicalJson([...expected.values()].sort((left, right) => left.path.localeCompare(right.path, "en-US")))) {
    throw staleValidation("Retained root inventory does not exactly cover receipt material.");
  }
  if (!isRecord(value.identity)) throw staleValidation("Retained root inventory identity is missing.");
  const payload = structuredClone(value) as Record<string, unknown>;
  delete payload.identity;
  if (canonicalJson(value.identity) !== canonicalJson(canonicalIdentity(payload, REGENERATION_INVENTORY_SCHEMA))) {
    throw staleValidation("Retained root inventory identity is detached.");
  }
  return value;
}

async function validateRetainedRun(
  referenceRoot: string,
  receipt: Readonly<Record<string, unknown>>,
  value: unknown,
  generatorBindings: readonly FileBinding[],
): Promise<Readonly<Record<string, unknown>>> {
  if (!isRecord(value)) throw staleValidation("Retained run record is missing.");
  assertExactKeys(value, [
    "runId", "receiptIdentity", "issuance", "receiptFile", "inventory", "transcripts", "outputs",
  ], "Retained run record");
  if (value.runId !== receipt.runId || canonicalJson(value.receiptIdentity) !== canonicalJson(receipt.identity)) {
    throw staleValidation("Retained run record is detached from its receipt.");
  }
  const retainedReceipt = await retainedReceiptBytes(referenceRoot, value.receiptFile, "Retained receipt file");
  const parsedReceipt = parsedRetainedJson(retainedReceipt.bytes, "Retained receipt file");
  if (canonicalJson(parsedReceipt) !== canonicalJson(receipt)) {
    throw staleValidation("Embedded receipt differs from retained receipt bytes.");
  }

  if (!isRecord(value.issuance)) throw staleValidation("Retained issuance wrapper is missing.");
  assertExactKeys(value.issuance, ["document", "file"], "Retained issuance wrapper");
  const issuance = validateRetainedIssuance(value.issuance.document, receipt, generatorBindings);
  const issuanceBytes = await retainedReceiptBytes(referenceRoot, value.issuance.file, "Retained issuance file");
  if (canonicalJson(parsedRetainedJson(issuanceBytes.bytes, "Retained issuance file")) !== canonicalJson(issuance)) {
    throw staleValidation("Embedded issuance differs from retained issuance bytes.");
  }

  if (!isRecord(value.inventory)) throw staleValidation("Retained inventory wrapper is missing.");
  assertExactKeys(value.inventory, ["document", "file"], "Retained inventory wrapper");
  const inventory = validateRetainedInventory(value.inventory.document, receipt, issuance);
  const inventoryBytes = await retainedReceiptBytes(referenceRoot, value.inventory.file, "Retained inventory file");
  if (canonicalJson(parsedRetainedJson(inventoryBytes.bytes, "Retained inventory file")) !== canonicalJson(inventory)) {
    throw staleValidation("Embedded inventory differs from retained inventory bytes.");
  }

  if (!Array.isArray(value.transcripts) || value.transcripts.length !== RECEIPT_COMMAND_SPECS.length) {
    throw staleValidation("Retained transcript set is incomplete.");
  }
  const transcripts = new Map<string, Readonly<Record<string, unknown>>>();
  for (const entry of value.transcripts) {
    if (!isRecord(entry)) throw staleValidation("Retained transcript wrapper is malformed.");
    assertExactKeys(entry, ["operation", "stdout", "stderr"], "Retained transcript wrapper");
    if (typeof entry.operation !== "string" || transcripts.has(entry.operation)) {
      throw staleValidation("Retained transcript operations are invalid or duplicated.");
    }
    transcripts.set(entry.operation, entry);
  }
  for (const command of receipt.commands as readonly Readonly<Record<string, unknown>>[]) {
    const retained = transcripts.get(command.operation as string);
    if (retained === undefined) throw staleValidation("Retained transcript operation is missing.");
    for (const stream of ["stdout", "stderr"] as const) {
      const captured = await retainedReceiptBytes(referenceRoot, retained[stream], `Retained ${String(command.operation)} ${stream}`, true);
      const expected = directBinding(command[stream], "Receipt transcript binding", true);
      if (captured.binding.sha256 !== expected.sha256 || captured.binding.sizeBytes !== expected.sizeBytes) {
        throw staleValidation(`Retained ${String(command.operation)} ${stream} differs from receipt identity.`);
      }
    }
  }

  if (!Array.isArray(value.outputs) || value.outputs.length !== RECEIPT_OUTPUT_PATHS.length) {
    throw staleValidation("Retained output set is incomplete.");
  }
  const retainedOutputs = new Map<string, Readonly<Record<string, unknown>>>();
  for (const entry of value.outputs) {
    if (!isRecord(entry)) throw staleValidation("Retained output wrapper is malformed.");
    assertExactKeys(entry, ["logicalPath", "file"], "Retained output wrapper");
    if (typeof entry.logicalPath !== "string" || retainedOutputs.has(entry.logicalPath)) {
      throw staleValidation("Retained output logical paths are invalid or duplicated.");
    }
    retainedOutputs.set(entry.logicalPath, entry);
  }
  for (const output of receipt.outputs as readonly unknown[]) {
    const expected = directBinding(output, "Receipt output binding");
    const retained = retainedOutputs.get(expected.path);
    if (retained === undefined) throw staleValidation(`Retained output ${expected.path} is missing.`);
    const captured = await retainedReceiptBytes(referenceRoot, retained.file, `Retained output ${expected.path}`);
    if (captured.binding.sha256 !== expected.sha256 || captured.binding.sizeBytes !== expected.sizeBytes) {
      throw staleValidation(`Retained output ${expected.path} differs from receipt identity.`);
    }
  }
  const inventoryFiles = new Map(
    (inventory.files as readonly unknown[]).map((entry) => {
      const binding = directBinding(entry, "Inventory file binding", true);
      return [binding.path, binding] as const;
    }),
  );
  const originalIssuance = inventoryFiles.get("writer-issuance.json");
  const originalReceipt = inventoryFiles.get("regeneration-run-receipt.json");
  if (
    originalIssuance === undefined || originalReceipt === undefined ||
    originalIssuance.sha256 !== issuanceBytes.binding.sha256 || originalIssuance.sizeBytes !== issuanceBytes.binding.sizeBytes ||
    originalReceipt.sha256 !== retainedReceipt.binding.sha256 || originalReceipt.sizeBytes !== retainedReceipt.binding.sizeBytes
  ) {
    throw staleValidation("Retained root inventory does not reproduce raw issuance and receipt bytes.");
  }
  return issuance;
}

async function validateRegeneration(
  referenceRoot: string,
  value: unknown,
  sourceDigest: string,
  sourceBindings: readonly FileBinding[],
  generatorSourceDigest: string,
  generatorBindings: readonly FileBinding[],
  executableValue: unknown,
): Promise<Readonly<Record<string, unknown>>> {
  if (!isRecord(value)) {
    throw staleValidation("Canonical validation is missing regeneration metadata.");
  }
  assertExactKeys(
    value,
    [
      "mode",
      "deterministicEvidencePending",
      "requiredForCandidatePass",
      "error",
      "note",
      "evidence",
    ],
    "Regeneration metadata",
  );
  if (
    value.mode !== "two-run-semantic-comparison" ||
    value.deterministicEvidencePending !== false ||
    value.requiredForCandidatePass !== true ||
    value.error !== null ||
    typeof value.note !== "string" ||
    value.note.length === 0
  ) {
    throw staleValidation(
      "A passing reference requires completed two-run semantic regeneration evidence.",
    );
  }
  const evidenceBinding = directBinding(value.evidence, "Regeneration evidence binding");
  const evidence = await boundJson(referenceRoot, evidenceBinding, "Regeneration evidence");
  assertExactKeys(evidence, [
    "schemaVersion", "receiptSchema", "status", "sourceDigest", "generatorSourceDigest",
    "generatorSourceHashes", "normalization", "runCount", "runs", "retainedRuns", "independence",
    "currentBoardSemanticSha256", "currentGeneratorReportSemanticSha256", "semanticMatch",
    "rawIdentityChecks", "currentReplayScripts", "toolchain",
  ], "Regeneration evidence");
  const executable = isRecord(executableValue) ? executableValue : undefined;
  const toolchain = isRecord(evidence.toolchain) ? evidence.toolchain : undefined;
  if (
    evidence.schemaVersion !== REGENERATION_EVIDENCE_SCHEMA ||
    evidence.receiptSchema !== REGENERATION_RECEIPT_SCHEMA ||
    evidence.status !== "pass" ||
    evidence.sourceDigest !== sourceDigest ||
    evidence.generatorSourceDigest !== generatorSourceDigest ||
    evidence.runCount !== 2 ||
    evidence.semanticMatch !== true ||
    executable === undefined ||
    toolchain === undefined ||
    toolchain.version !== executable.version ||
    toolchain.commit !== executable.commit ||
    toolchain.cliSha256 !== executable.sha256 ||
    toolchain.capabilityHelpSha256 !== executable.capabilityHelpSha256 ||
    canonicalJson(evidence.generatorSourceHashes) !== canonicalJson(generatorBindings) ||
    !Array.isArray(evidence.runs) ||
    evidence.runs.length !== 2
  ) {
    throw staleValidation("Regeneration evidence does not agree with source, generator, or toolchain identity.");
  }
  assertExactKeys(toolchain, ["version", "commit", "cliSha256", "capabilityHelpSha256"], "Regeneration toolchain");
  const runs = (evidence.runs as readonly unknown[]).map((run) =>
    validateRunReceipt(
      run,
      sourceDigest,
      sourceBindings,
      generatorSourceDigest,
      generatorBindings,
      executable,
    )
  );
  const outputFor = (run: Readonly<Record<string, unknown>>, logicalPath: string): FileBinding => {
    const outputs = run.outputs as readonly unknown[];
    const matches = outputs.map((entry) => directBinding(entry, "Regeneration receipt output"))
      .filter((entry) => entry.path === logicalPath);
    if (matches.length !== 1) throw staleValidation(`Regeneration receipt omits ${logicalPath}.`);
    return matches[0]!;
  };
  const boardDigests = runs.map((run) => outputFor(run, "robotics-controller-v0.kicad_pcb").sha256);
  const reportDigests = runs.map((run) => outputFor(run, "route-report.json").sha256);
  const preparationDigests = runs.map((run) => outputFor(run, "preparation-report.json").sha256);
  const projectDigests = runs.map((run) => outputFor(run, "robotics-controller-v0.kicad_pro").sha256);
  const canonicalBoard = sourceBindings.find((entry) => entry.path === "robotics-controller-v0.kicad_pcb");
  const canonicalProject = sourceBindings.find((entry) => entry.path === "robotics-controller-v0.kicad_pro");
  if (
    canonicalBoard === undefined || canonicalProject === undefined ||
    new Set(boardDigests).size !== 1 ||
    boardDigests[0] !== evidence.currentBoardSemanticSha256 ||
    boardDigests[0] !== canonicalBoard.sha256 ||
    projectDigests[0] !== canonicalProject.sha256 ||
    new Set(reportDigests).size !== 1 ||
    new Set(preparationDigests).size !== 1 ||
    new Set(projectDigests).size !== 1 ||
    typeof evidence.currentGeneratorReportSemanticSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(evidence.currentGeneratorReportSemanticSha256)
  ) {
    throw staleValidation("Two-run receipt output identities do not agree.");
  }
  if (!Array.isArray(evidence.retainedRuns) || evidence.retainedRuns.length !== 2) {
    throw staleValidation("Regeneration evidence must retain exactly two run bundles.");
  }
  const issuances = await Promise.all(
    runs.map((run, index) =>
      validateRetainedRun(referenceRoot, run, (evidence.retainedRuns as readonly unknown[])[index], generatorBindings)
    ),
  );
  const roots = runs.map((run) => run.rootBinding as {
    readonly pathDigest: string;
    readonly ancestryDigests: readonly string[];
  });
  const commandSets = runs.map((run) => new Set(
    (run.commands as readonly Readonly<Record<string, unknown>>[]).map((command) => command.commandId as string),
  ));
  const recomputedIndependence = {
    distinctCanonicalRoots: new Set(roots.map((root) => root.pathDigest)).size === 2,
    disjointRoots: roots.every((left, index) =>
      roots.every((right, other) => index === other || !right.ancestryDigests.includes(left.pathDigest))
    ),
    distinctRunIds: new Set(runs.map((run) => run.runId)).size === 2,
    distinctNonces: new Set(runs.map((run) => run.nonce)).size === 2,
    distinctRootBindings: new Set(runs.map((run) => canonicalJson(run.rootBinding))).size === 2,
    distinctReceiptIdentities: new Set(runs.map((run) =>
      (run.identity as { readonly digest: string }).digest
    )).size === 2,
    independentlyExecutedCommands:
      runs.every((run) => (run.commands as readonly unknown[]).length === RECEIPT_COMMAND_SPECS.length) &&
      [...commandSets[0]!].every((commandId) => !commandSets[1]!.has(commandId)),
    writerChallengesMatched: issuances.every((issuance, index) =>
      issuance.challenge === runs[index]!.nonce &&
      canonicalJson(issuance.identity) === canonicalJson(runs[index]!.issuanceIdentity) &&
      canonicalJson(issuance.rootBinding) === canonicalJson(runs[index]!.rootBinding)
    ),
  };
  const independence = isRecord(evidence.independence) ? evidence.independence : undefined;
  if (independence === undefined) throw staleValidation("Regeneration independence proof is missing.");
  assertExactKeys(independence, [
    "distinctCanonicalRoots", "disjointRoots", "distinctRunIds", "distinctNonces",
    "distinctRootBindings", "distinctReceiptIdentities", "independentlyExecutedCommands",
    "writerChallengesMatched",
  ], "Regeneration independence proof");
  if (
    canonicalJson(independence) !== canonicalJson(recomputedIndependence) ||
    Object.values(recomputedIndependence).some((entry) => entry !== true)
  ) {
    throw staleValidation("Regeneration independence proof does not reproduce retained run evidence.");
  }
  const rawChecks = isRecord(evidence.rawIdentityChecks) ? evidence.rawIdentityChecks : undefined;
  const currentReplayScripts = isRecord(evidence.currentReplayScripts)
    ? evidence.currentReplayScripts
    : undefined;
  if (
    evidence.normalization !==
      "none; fixed stage-specific KiCad KIID seeds produced byte-identical files" ||
    rawChecks === undefined ||
    currentReplayScripts === undefined
  ) {
    throw staleValidation("Regeneration evidence omits exact raw-identity/replay-script proof.");
  }
  assertExactKeys(
    rawChecks,
    ["board", "generatorReport", "preparationReport", "project", "replayScripts", "routingSeed", "receipts"],
    "Regeneration raw identity checks",
  );
  if (Object.values(rawChecks).some((value) => value !== true)) {
    throw staleValidation("At least one raw regeneration identity check is non-passing.");
  }
  assertExactKeys(
    currentReplayScripts,
    REFERENCE_KICAD_REPLAY_SCRIPT_PATHS,
    "Current replay script identities",
  );
  for (const relativePath of REFERENCE_KICAD_REPLAY_SCRIPT_PATHS) {
    const expectedDigest = currentReplayScripts[relativePath];
    if (typeof expectedDigest !== "string" || !/^[0-9a-f]{64}$/u.test(expectedDigest)) {
      throw staleValidation(`Replay script ${relativePath} has an invalid identity.`);
    }
    const scriptPath = await resolveConfinedExistingFile(
      referenceRoot,
      referenceRoot,
      relativePath,
      `Replay script ${relativePath}`,
    );
    const actualDigest = contentIdentity(
      await regularFileBytes(scriptPath, `Replay script ${relativePath}`),
    ).digest;
    if (actualDigest !== expectedDigest) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_VALIDATION_STALE",
        "DIGEST_MISMATCH",
        `Replay script ${relativePath} differs from deterministic-run evidence.`,
        { expectedDigest, actualDigest },
      );
    }
  }
  return {
    mode: value.mode,
    deterministicEvidencePending: false,
    requiredForCandidatePass: true,
    evidence: evidenceBinding,
    note: value.note,
  };
}

function validateExecutableManifest(value: unknown): void {
  if (!isRecord(value)) throw staleValidation("Canonical validation is missing executable metadata.");
  assertExactKeys(
    value,
    [
      "kind",
      "executablePath",
      "sizeBytes",
      "sha256",
      "version",
      "commit",
      "capabilityHelpSha256",
      "capabilityProbeArgs",
      "identityMatchesAdapter",
    ],
    "Executable metadata",
  );
  const expectedProbeArgs = EXPECTED_VALIDATION_INVOCATIONS
    .filter(([id]) => id.startsWith("help-"))
    .map(([, args]) => [...args]);
  if (
    value.kind !== "kicad-cli" ||
    typeof value.executablePath !== "string" ||
    !path.isAbsolute(value.executablePath) ||
    value.version !== REFERENCE_KICAD_VERSION ||
    typeof value.commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.commit) ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) <= 0 ||
    typeof value.capabilityHelpSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.capabilityHelpSha256) ||
    canonicalJson(value.capabilityProbeArgs) !== canonicalJson(expectedProbeArgs) ||
    value.identityMatchesAdapter !== true
  ) {
    throw staleValidation("Canonical executable metadata is malformed or incomplete.");
  }
}

function validateSourceBindings(
  value: unknown,
  manifestSourceDigest: unknown,
): readonly FileBinding[] {
  if (!Array.isArray(value)) {
    throw staleValidation("Canonical validation sourceBindings must be an array.");
  }
  const parsed = value.map((entry) => fileBindingFromRecord(entry));
  if (parsed.some((entry) => entry === undefined)) {
    throw staleValidation("Canonical validation contains an invalid non-empty source binding.");
  }
  const bindings = parsed as readonly FileBinding[];
  const paths = bindings.map((binding) => binding.path);
  const expectedPaths = [...REQUIRED_SOURCE_PATHS].sort((left, right) => left.localeCompare(right, "en-US"));
  const unsupportedPaths = paths.filter(
    (candidate) =>
      !expectedPaths.includes(candidate as (typeof REQUIRED_SOURCE_PATHS)[number]) &&
      !ALLOWED_ADDITIONAL_SOURCE_PATTERN.test(candidate),
  );
  if (
    new Set(paths).size !== paths.length ||
    canonicalJson(paths) !==
      canonicalJson([...paths].sort((left, right) => left.localeCompare(right, "en-US"))) ||
    expectedPaths.some((requiredPath) => !paths.includes(requiredPath)) ||
    unsupportedPaths.length > 0
  ) {
    throw staleValidation(
      "Canonical validation sourceBindings must be a sorted, confined reference source allowlist.",
      { requiredPaths: expectedPaths, unsupportedPaths, actualPaths: paths },
    );
  }
  const recomputedSourceDigest = contentIdentity(canonicalJson(bindings)).digest;
  if (manifestSourceDigest !== recomputedSourceDigest) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "DIGEST_MISMATCH",
      "Canonical validation sourceDigest does not match sourceBindings.",
      { expected: manifestSourceDigest, actual: recomputedSourceDigest },
    );
  }
  return bindings;
}

async function validateProjectLocalLibraryBindings(
  referenceRoot: string,
  sourceBindings: readonly FileBinding[],
): Promise<void> {
  const tableTexts = await Promise.all(
    ["sym-lib-table", "fp-lib-table"].map(async (tableName) => {
      const tablePath = await resolveConfinedExistingFile(
        referenceRoot,
        referenceRoot,
        tableName,
        tableName,
      );
      return (await regularFileBytes(tablePath, tableName)).toString("utf8");
    }),
  );
  const declared = sortedUnique(
    tableTexts.flatMap((tableText) =>
      [...tableText.matchAll(/\$\{KIPRJMOD\}[\\/]([^"\r\n)]+)/gu)].map((match) =>
        (match[1] ?? "").trim().replaceAll("\\", "/"),
      ),
    ),
  );
  if (declared.some((logicalPath) => !isSafeLogicalPath(logicalPath))) {
    throw staleValidation("Project-local KiCad library table contains an unsafe path.");
  }
  const localBindings = sourceBindings
    .map((binding) => binding.path)
    .filter((logicalPath) => logicalPath.startsWith("symbols/") || logicalPath.startsWith("footprints/"));
  for (const logicalPath of declared) {
    const covered = logicalPath.endsWith(".pretty")
      ? localBindings.some((bindingPath) => bindingPath.startsWith(`${logicalPath}/`))
      : localBindings.includes(logicalPath);
    if (!covered) {
      throw staleValidation(`Project-local library ${logicalPath} has no exact source binding.`);
    }
  }
  for (const bindingPath of localBindings) {
    const declaredForBinding = declared.some((logicalPath) =>
      logicalPath.endsWith(".pretty")
        ? bindingPath.startsWith(`${logicalPath}/`)
        : bindingPath === logicalPath,
    );
    if (!declaredForBinding) {
      throw staleValidation(`Source binding ${bindingPath} is not declared by a project library table.`);
    }
  }
}

function validatedRunRoot(manifest: Readonly<Record<string, unknown>>): string {
  const run = manifest.run;
  if (!isRecord(run) || !isRecord(run.privateEnvironment)) {
    throw staleValidation("Canonical validation is missing run isolation metadata.");
  }
  assertExactKeys(run, ["id", "root", "privateEnvironment"], "Validation run metadata");
  assertExactKeys(
    run.privateEnvironment,
    ["kicadConfig", "appData", "localAppData", "temp"],
    "Validation private environment",
  );
  if (
    typeof run.id !== "string" ||
    !/^\d{8}T\d{6}\.\d{6}Z-[0-9a-f]{16}$/u.test(run.id) ||
    run.root !== `validation/runs/${run.id}`
  ) {
    throw staleValidation("Validation run identity/root is malformed.");
  }
  const expectedPrivate = {
    kicadConfig: `${run.root}/private/kicad-config`,
    appData: `${run.root}/private/appdata`,
    localAppData: `${run.root}/private/localappdata`,
    temp: `${run.root}/private/temp`,
  };
  if (canonicalJson(run.privateEnvironment) !== canonicalJson(expectedPrivate)) {
    throw staleValidation("Validation run private-environment paths are not isolated under its run root.");
  }
  return run.root;
}

function validateIsolatedInputBindings(
  manifest: Readonly<Record<string, unknown>>,
  sourceBindings: readonly FileBinding[],
  runRoot: string,
): void {
  if (!Array.isArray(manifest.validationInputBindings)) {
    throw staleValidation("Canonical validationInputBindings must be an array.");
  }
  const isolated = manifest.validationInputBindings.map((entry) =>
    directBinding(entry, "Validation input binding"),
  );
  const expectedPrefix = `${runRoot}/isolate/reference-input/`;
  const normalized = isolated.map((binding) => ({
    ...binding,
    path: binding.path.startsWith(expectedPrefix)
      ? binding.path.slice(expectedPrefix.length)
      : binding.path,
  }));
  if (canonicalJson(normalized) !== canonicalJson(sourceBindings)) {
    throw staleValidation("Isolated validation inputs do not exactly match canonical source bindings.");
  }
  const preservation = manifest.validationInputPreservation;
  if (!isRecord(preservation)) {
    throw staleValidation("Canonical validation is missing isolated-input preservation evidence.");
  }
  assertExactKeys(
    preservation,
    ["unchanged", "before", "after"],
    "Validation input preservation",
  );
  if (
    preservation.unchanged !== true ||
    canonicalJson(preservation.before) !== canonicalJson(isolated) ||
    canonicalJson(preservation.after) !== canonicalJson(isolated)
  ) {
    throw staleValidation("Isolated validation input bytes changed while native checks ran.");
  }
}

function validateGeneratorSourceAgreement(manifest: Readonly<Record<string, unknown>>): void {
  if (!Array.isArray(manifest.generatorSourceHashes)) {
    throw staleValidation("Canonical validation generatorSourceHashes must be an array.");
  }
  const bindings = manifest.generatorSourceHashes.map((entry) =>
    directBinding(entry, "Generator source binding"),
  );
  const recomputed = contentIdentity(canonicalJson(bindings)).digest;
  if (manifest.generatorSourceDigest !== recomputed) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "DIGEST_MISMATCH",
      "generatorSourceDigest does not match generatorSourceHashes.",
    );
  }
  const preservation = manifest.generatorSourcePreservation;
  if (
    !isRecord(preservation) ||
    preservation.unchanged !== true ||
    canonicalJson(preservation.before) !== canonicalJson(bindings) ||
    canonicalJson(preservation.after) !== canonicalJson(bindings)
  ) {
    throw staleValidation("Generator source-preservation evidence is stale or incomplete.");
  }
}

async function verifyManifestFileBindings(
  referenceRoot: string,
  manifest: Readonly<Record<string, unknown>>,
  nativeContractAuthority: ReferenceControllerRevANativeAuthoritySnapshot,
): Promise<readonly FileBinding[]> {
  const bindingRecords = collectFileBindingRecords(manifest);
  const unique = new Map<string, FileBinding>();
  for (const binding of bindingRecords) {
    const previous = unique.get(binding.path);
    if (
      previous !== undefined &&
      (previous.sha256 !== binding.sha256 || previous.sizeBytes !== binding.sizeBytes)
    ) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_VALIDATION_STALE",
        "DIGEST_MISMATCH",
        `Canonical validation contains conflicting bindings for ${binding.path}.`,
      );
    }
    unique.set(binding.path, binding);
  }
  if (unique.size === 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "EVIDENCE_STALE",
      "Canonical validation contains no independently verifiable file bindings.",
    );
  }

  for (const binding of unique.values()) {
    if (binding.path === REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH) {
      assertNativeContractFileBinding(
        binding,
        "Canonical native-contract file binding",
        nativeContractAuthority,
      );
      continue;
    }
    let actual: FileBinding;
    try {
      const filePath = await resolveConfinedExistingFile(
        referenceRoot,
        referenceRoot,
        binding.path,
        `Canonical validation binding ${binding.path}`,
      );
      actual = await bindingFor(filePath, binding.path, true);
    } catch (error) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_VALIDATION_STALE",
        "EVIDENCE_STALE",
        `Canonical validation binding is missing or unreadable for ${binding.path}.`,
        {},
        false,
        { cause: error },
      );
    }
    if (actual.sha256 !== binding.sha256 || actual.sizeBytes !== binding.sizeBytes) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_VALIDATION_STALE",
        "DIGEST_MISMATCH",
        `Canonical validation binding is stale for ${binding.path}.`,
        { expected: binding, actual },
      );
    }
  }
  return [...unique.values()]
    .filter((binding) => binding.path !== REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH)
    .sort((left, right) => left.path.localeCompare(right.path, "en-US"));
}

function directBinding(
  value: unknown,
  label: string,
  allowEmpty = false,
): FileBinding {
  const binding = fileBindingFromRecord(value, allowEmpty);
  if (binding === undefined) {
    throw staleValidation(`${label} is not a valid ${allowEmpty ? "" : "non-empty "}file binding.`);
  }
  return binding;
}

async function boundJson(
  referenceRoot: string,
  binding: FileBinding,
  label: string,
): Promise<Readonly<Record<string, unknown>>> {
  const filePath = await resolveConfinedExistingFile(
    referenceRoot,
    referenceRoot,
    binding.path,
    label,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse((await ordinaryFileBytes(filePath, label, binding.sizeBytes === 0)).toString("utf8"));
  } catch (error) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "EVIDENCE_STALE",
      `${label} is not valid JSON.`,
      {},
      false,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) throw staleValidation(`${label} must be a JSON object.`);
  return parsed;
}

function assertCodePointSortedUniqueStrings(values: readonly string[], label: string): void {
  const sorted = [...new Set(values)].sort();
  if (canonicalJson(values) !== canonicalJson(sorted)) {
    throw staleValidation(`${label} must be unique and sorted by Unicode code point.`);
  }
}

async function validateNativeReportAgreement(
  referenceRoot: string,
  manifest: Readonly<Record<string, unknown>>,
  sourceDigest: string,
  sourceBindings: readonly FileBinding[],
  runRoot: string,
): Promise<void> {
  const ercRecord = checkRecord(manifest, "erc");
  const drcRecord = checkRecord(manifest, "drc");
  const erc = await boundJson(referenceRoot, directBinding(ercRecord, "ERC report binding"), "ERC report");
  const drc = await boundJson(referenceRoot, directBinding(drcRecord, "DRC report binding"), "DRC report");
  if (
    directBinding(ercRecord, "ERC report binding").path !== `${runRoot}/erc.json` ||
    directBinding(drcRecord, "DRC report binding").path !== `${runRoot}/drc.json`
  ) {
    throw staleValidation("Native check reports are not bound to the declared validation run.");
  }
  for (const [kind, report, record, sourceName] of [
    ["ERC", erc, ercRecord, `${DESIGN_NAME}.kicad_sch`],
    ["DRC", drc, drcRecord, `${DESIGN_NAME}.kicad_pcb`],
  ] as const) {
    if (
      report.$schema !== `https://schemas.kicad.org/${kind.toLocaleLowerCase("en-US")}.v1.json` ||
      report.coordinate_units !== "mm" ||
      report.kicad_version !== REFERENCE_KICAD_VERSION ||
      report.source !== sourceName ||
      typeof report.date !== "string" ||
      !Number.isFinite(Date.parse(report.date)) ||
      record.sourceDigest !== sourceDigest
    ) {
      throw staleValidation(`${kind} report metadata does not agree with its manifest subject.`);
    }
  }
  const sheets = erc.sheets;
  if (!Array.isArray(sheets) || sheets.some((sheet) => !isRecord(sheet) || !Array.isArray(sheet.violations))) {
    throw staleValidation("ERC report sheets/violations are malformed.");
  }
  let ercCount = 0;
  for (const sheet of sheets) {
    const violationsForSheet = (sheet as Readonly<Record<string, unknown>>).violations;
    if (!Array.isArray(violationsForSheet)) {
      throw staleValidation("ERC report sheet violations are malformed.");
    }
    ercCount += violationsForSheet.length;
  }
  if (integerField(ercRecord, "violationCount", "ERC manifest") !== ercCount) {
    throw staleValidation("ERC manifest count does not agree with the bound report.");
  }
  const violations = drc.violations;
  const unconnected = drc.unconnected_items;
  const parity = drc.schematic_parity;
  if (!Array.isArray(violations) || !Array.isArray(unconnected) || !Array.isArray(parity)) {
    throw staleValidation("DRC report findings arrays are malformed.");
  }
  if (
    integerField(drcRecord, "violationCount", "DRC manifest") !== violations.length ||
    integerField(drcRecord, "unconnectedCount", "DRC manifest") !== unconnected.length ||
    integerField(drcRecord, "schematicParityCount", "DRC manifest") !== parity.length
  ) {
    throw staleValidation("DRC manifest counts do not agree with the bound report.");
  }
  if (
    ercRecord.reportValid !== true ||
    ercRecord.reportError !== null ||
    ercRecord.commandReportAgreement !== true ||
    integerField(ercRecord, "reportFindingCount", "ERC manifest") !== ercCount ||
    drcRecord.reportValid !== true ||
    drcRecord.reportError !== null ||
    drcRecord.commandReportAgreement !== true ||
    integerField(drcRecord, "reportFindingCount", "DRC manifest") !==
      violations.length + unconnected.length + parity.length
  ) {
    throw staleValidation("Native command/report agreement metadata is not passing.");
  }
  const canonicalBoard = sourceBindings.find(
    (binding) => binding.path === `${DESIGN_NAME}.kicad_pcb`,
  );
  const preRefill = directBinding(drcRecord.preRefillBoard, "Pre-refill board binding");
  const evaluated = directBinding(drcRecord.evaluatedBoard, "DRC-evaluated board binding");
  if (
    canonicalBoard === undefined ||
    preRefill.path !== `${runRoot}/evidence/pre-refill/${DESIGN_NAME}.kicad_pcb` ||
    preRefill.sha256 !== canonicalBoard.sha256 ||
    preRefill.sizeBytes !== canonicalBoard.sizeBytes ||
    evaluated.path !== `${runRoot}/evidence/drc-evaluated/${DESIGN_NAME}.kicad_pcb` ||
    drcRecord.evaluatedBoardDigest !== evaluated.sha256 ||
    drcRecord.evaluatedBoardUnchangedAfterExports !== true
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "DIGEST_MISMATCH",
      "DRC pre-refill/evaluated board bindings do not agree with canonical and export subjects.",
    );
  }
}

async function validateConnectivityAgreement(
  referenceRoot: string,
  manifest: Readonly<Record<string, unknown>>,
  sourceDigest: string,
  runRoot: string,
  nativeContractAuthority: ReferenceControllerRevANativeAuthoritySnapshot,
): Promise<void> {
  if (
    REFERENCE_KICAD_REQUIRED_NETS.length !== 48 ||
    canonicalJson(REFERENCE_KICAD_REQUIRED_NETS) !==
      canonicalJson(nativeContractAuthority.contract.requiredNativeNets)
  ) {
    throw staleValidation("The fixed reference connectivity contract must contain exactly 48 required nets.");
  }
  const record = checkRecord(manifest, "connectivity");
  const binding = directBinding(record, "Connectivity report binding");
  if (binding.path !== `${runRoot}/connectivity.json`) {
    throw staleValidation("Connectivity evidence is not bound to the declared validation run.");
  }
  const document = await boundJson(
    referenceRoot,
    binding,
    "Connectivity report",
  );
  const netNames = safeStringArray(document.netNames, "Connectivity netNames");
  const boardNetNames = safeStringArray(document.boardNetNames, "Connectivity boardNetNames");
  const references = safeStringArray(document.schematicReferences, "Connectivity references");
  const semanticAliasNetNames = safeStringArray(
    document.semanticAliasNetNames,
    "Connectivity semanticAliasNetNames",
    true,
  );
  const semanticAliasBoardNetNames = safeStringArray(
    document.semanticAliasBoardNetNames,
    "Connectivity semanticAliasBoardNetNames",
    true,
  );
  const missing = safeStringArray(document.missingRequiredNets, "Connectivity missingRequiredNets", true);
  const missingBoard = safeStringArray(
    document.missingRequiredBoardNets,
    "Connectivity missingRequiredBoardNets",
    true,
  );
  assertCodePointSortedUniqueStrings(netNames, "Connectivity netNames");
  assertCodePointSortedUniqueStrings(boardNetNames, "Connectivity boardNetNames");
  assertCodePointSortedUniqueStrings(references, "Connectivity references");
  assertCodePointSortedUniqueStrings(
    semanticAliasNetNames,
    "Connectivity semanticAliasNetNames",
  );
  assertCodePointSortedUniqueStrings(
    semanticAliasBoardNetNames,
    "Connectivity semanticAliasBoardNetNames",
  );
  assertCodePointSortedUniqueStrings(missing, "Connectivity missingRequiredNets");
  const requiredNetContractFile = directBinding(
    document.requiredNetContractFile,
    "Connectivity required-net contract file",
  );
  assertNativeContractFileBinding(
    requiredNetContractFile,
    "Connectivity required-net contract file",
    nativeContractAuthority,
  );
  const missingFromDocument = REFERENCE_KICAD_REQUIRED_NETS.filter(
    (name) => !new Set(netNames).has(name),
  );
  const missingFromBoard = REFERENCE_KICAD_REQUIRED_NETS.filter(
    (name) => !new Set(boardNetNames).has(name),
  );
  const boardRecords = integerField(document, "boardNetlistRecordCount", "Connectivity report", 1);
  if (
    document.schemaVersion !== "evleda.reference-connectivity.v1" ||
    document.sourceDigest !== sourceDigest ||
    document.requiredNetContract !== "robotics-controller-v0.backend-v1" ||
    canonicalJson(document.requiredNetContractIdentity) !==
      canonicalJson(nativeContractAuthority.semanticIdentity) ||
    canonicalJson(document.requiredNetContractContentIdentity) !==
      canonicalJson(nativeContractAuthority.contentIdentity) ||
    document.schematicNetlistParseError !== null ||
    document.requiredNetCount !== REFERENCE_KICAD_REQUIRED_NETS.length ||
    document.boardFormatValid !== true ||
    document.status !== "pass" ||
    integerField(document, "netCount", "Connectivity report", 1) !== netNames.length ||
    integerField(document, "schematicComponentCount", "Connectivity report", 1) !== references.length ||
    missing.length !== 0 ||
    missingBoard.length !== 0 ||
    semanticAliasNetNames.length !== 0 ||
    semanticAliasBoardNetNames.length !== 0 ||
    missingFromDocument.length !== 0 ||
    missingFromBoard.length !== 0 ||
    record.sourceDigest !== sourceDigest ||
    integerField(record, "missingRequiredNetCount", "Connectivity manifest") !== 0 ||
    integerField(record, "missingRequiredBoardNetCount", "Connectivity manifest") !== 0 ||
    integerField(record, "boardNetlistRecordCount", "Connectivity manifest", 1) !== boardRecords
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_CONNECTIVITY_FAILED",
      "GATE_FAILED",
      "Canonical connectivity evidence does not agree with the 48-net reference contract.",
      { missingRequiredNets: missingFromDocument, missingRequiredBoardNets: missingFromBoard },
    );
  }
}

async function validateComponentMetadataAgreement(
  referenceRoot: string,
  manifest: Readonly<Record<string, unknown>>,
  sourceDigest: string,
  sourceBindings: readonly FileBinding[],
  runRoot: string,
): Promise<void> {
  const connectivity = checkRecord(manifest, "connectivity");
  const record = checkRecord(connectivity, "componentMetadata");
  const reportFile = directBinding(record, "Component metadata report binding");
  if (
    reportFile.path !== `${runRoot}/component-metadata.json` ||
    record.sourceDigest !== sourceDigest ||
    record.status !== "pass" ||
    integerField(record, "mismatchCount", "Component metadata manifest") !== 0 ||
    integerField(record, "errorCount", "Component metadata manifest") !== 0
  ) {
    throw staleValidation("Component metadata manifest is missing, failed, or bound to the wrong validation run.");
  }
  const document = await boundJson(referenceRoot, reportFile, "Component metadata report");
  if (
    document.schemaVersion !== "evleda.reference-component-metadata.v1" ||
    document.status !== "pass" ||
    document.sourceDigest !== sourceDigest ||
    !Array.isArray(document.mismatches) ||
    document.mismatches.length !== 0 ||
    !Array.isArray(document.errors) ||
    document.errors.length !== 0 ||
    !isRecord(document.sourceBindings) ||
    !isRecord(document.sourceComponentCounts)
  ) {
    throw staleValidation("Component metadata report is malformed or non-passing.");
  }
  const expectedCount = integerField(document, "expectedComponentCount", "Component metadata report", 1);
  if (
    integerField(
      checkRecord(manifest, "placement"),
      "footprintCount",
      "Placement manifest",
      1,
    ) !== expectedCount
  ) {
    throw staleValidation("Placement/generator footprint count does not agree with component metadata.");
  }
  for (const sourceName of ["schematic", "pcb", "bom"] as const) {
    if (
      integerField(
        document.sourceComponentCounts,
        sourceName,
        "Component metadata source counts",
        1,
      ) !== expectedCount
    ) {
      throw staleValidation("Component metadata source counts do not agree with the design-data count.");
    }
  }

  const expectedPaths = {
    schematic: `${runRoot}/outputs/schematic-netlist.kicad_net`,
    pcb: `${runRoot}/evidence/drc-evaluated/${DESIGN_NAME}.kicad_pcb`,
    bom: `${runRoot}/outputs/bom.csv`,
  } as const;
  const bytes = new Map<keyof typeof expectedPaths, Buffer>();
  for (const sourceName of Object.keys(expectedPaths) as readonly (keyof typeof expectedPaths)[]) {
    const declared = directBinding(
      document.sourceBindings[sourceName],
      `Component metadata ${sourceName} source binding`,
    );
    if (declared.path !== expectedPaths[sourceName]) {
      throw staleValidation(`Component metadata ${sourceName} source is bound to the wrong path.`);
    }
    const filePath = await resolveConfinedExistingFile(
      referenceRoot,
      referenceRoot,
      declared.path,
      `Component metadata ${sourceName} source`,
    );
    const actual = await bindingFor(filePath, declared.path, true);
    if (canonicalJson(actual) !== canonicalJson(declared)) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_VALIDATION_STALE",
        "DIGEST_MISMATCH",
        `Component metadata ${sourceName} source binding is stale.`,
        { expected: declared, actual },
      );
    }
    bytes.set(sourceName, await regularFileBytes(filePath, `Component metadata ${sourceName} source`));
  }

  const canonicalBoard = sourceBindings.find(
    (binding) => binding.path === `${DESIGN_NAME}.kicad_pcb`,
  );
  if (canonicalBoard === undefined) {
    throw staleValidation("Component metadata validation cannot locate the canonical PCB binding.");
  }
  const canonicalBoardPath = await resolveConfinedExistingFile(
    referenceRoot,
    referenceRoot,
    canonicalBoard.path,
    "Canonical PCB component metadata source",
  );
  const canonicalBoardBytes = await regularFileBytes(
    canonicalBoardPath,
    "Canonical PCB component metadata source",
  );
  const canonicalSelected = assertReferencePcbComponentMetadata(
    canonicalBoardBytes,
    ROBOTICS_CONTROLLER_V0,
  );
  const schematicSelected = assertReferenceSchematicComponentMetadata(
    bytes.get("schematic")!,
    ROBOTICS_CONTROLLER_V0,
  );
  const evaluatedPcbSelected = assertReferencePcbComponentMetadata(
    bytes.get("pcb")!,
    ROBOTICS_CONTROLLER_V0,
  );
  const bomSummary = parseBom(bytes.get("bom")!, ROBOTICS_CONTROLLER_V0);
  const bomSelected = bomSummary.selectedComponents;
  if (
    canonicalJson(canonicalSelected) !== canonicalJson(schematicSelected) ||
    canonicalJson(canonicalSelected) !== canonicalJson(evaluatedPcbSelected) ||
    canonicalJson(canonicalSelected) !== canonicalJson(bomSelected)
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "GATE_FAILED",
      "Canonical PCB, DRC-evaluated PCB, schematic netlist, and BOM selected-component metadata differ.",
      {
        canonicalPcb: canonicalSelected,
        evaluatedPcb: evaluatedPcbSelected,
        schematic: schematicSelected,
        bom: bomSelected,
      },
    );
  }

  const exportsRecord = checkRecord(manifest, "exports");
  if (!Array.isArray(exportsRecord.artifacts)) {
    throw staleValidation("Component metadata validation cannot locate the position export binding.");
  }
  const expectedPositionPath = `${runRoot}/outputs/positions.csv`;
  const positionBindings = exportsRecord.artifacts
    .filter((entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.path === expectedPositionPath
    )
    .map((entry) => directBinding(entry, "Position export binding"));
  if (positionBindings.length !== 1) {
    throw staleValidation("Canonical validation must bind exactly one position export.");
  }
  const positionPath = await resolveConfinedExistingFile(
    referenceRoot,
    referenceRoot,
    positionBindings[0]!.path,
    "Canonical position export",
  );
  const actualPositionBinding = await bindingFor(positionPath, expectedPositionPath, true);
  if (canonicalJson(actualPositionBinding) !== canonicalJson(positionBindings[0])) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "DIGEST_MISMATCH",
      "Canonical position export binding is stale.",
      { expected: positionBindings[0], actual: actualPositionBinding },
    );
  }
  const position = parsePositionSummary(
    await regularFileBytes(positionPath, "Canonical position export"),
  );
  const positionPolicy = pcbPositionReferencePolicy(
    pcbPositionReferenceSource(parsePcbComponents(canonicalBoardBytes)),
    validationPositionExportSettings(manifest),
    bomSummary.dnpReferences,
  );
  assertReferenceSetAgreement({
    observed: position.references,
    expected: positionPolicy.expectedPositionReferences,
    relationship: "exact",
    source: "Canonical KiCad position export",
    expectedSource: "the PCB position-export policy",
    failureCode: "REFERENCE_POSITION_PARITY_FAILED",
    details: {
      positionExportPolicy: positionPolicy,
      exportedPositionRowCount: position.rowCount,
    },
  });
}

async function validateRoutingPlacementAgreement(
  referenceRoot: string,
  manifest: Readonly<Record<string, unknown>>,
  sourceBindings: readonly FileBinding[],
  runRoot: string,
): Promise<void> {
  const routing = checkRecord(manifest, "routing");
  const placement = checkRecord(manifest, "placement");
  const geometry = checkRecord(manifest, "geometry");
  const generatorBinding = directBinding(routing.generatorReport, "PCB generator report binding");
  if (generatorBinding.path !== `${runRoot}/evidence/pre-refill/pcb-generation.json`) {
    throw staleValidation("PCB generator evidence is not bound to the declared validation run.");
  }
  const generator = await boundJson(
    referenceRoot,
    generatorBinding,
    "PCB generator report",
  );
  const boardBinding = sourceBindings.find(
    (binding) => binding.path === `${DESIGN_NAME}.kicad_pcb`,
  );
  const generatorEvidence = isRecord(routing.generatorReport)
    ? routing.generatorReport
    : undefined;
  const preRefillBoard = directBinding(
    generatorEvidence?.preRefillBoard,
    "Generator pre-refill board binding",
  );
  const generatorSemanticPayload = structuredClone(generator) as Record<string, unknown>;
  delete generatorSemanticPayload.boardSha256;
  const generatorSemanticDigest = contentIdentity(canonicalJson(generatorSemanticPayload)).digest;
  if (
    boardBinding === undefined ||
    generatorEvidence === undefined ||
    generatorEvidence.trustedForRoutingCounts !== true ||
    generatorEvidence.error !== null ||
    generatorEvidence.canonicalSourceUnchanged !== true ||
    generatorEvidence.currentSemanticSha256 !== generatorSemanticDigest ||
    preRefillBoard.path !== `${runRoot}/evidence/pre-refill/${DESIGN_NAME}.kicad_pcb` ||
    preRefillBoard.sha256 !== boardBinding.sha256 ||
    preRefillBoard.sizeBytes !== boardBinding.sizeBytes ||
    generator.schema_version !== 2 ||
    generator.generator !== "KiCad pcbnew Python API" ||
    generator.kicad_version !== REFERENCE_KICAD_VERSION ||
    generator.boardPath !== `${DESIGN_NAME}.kicad_pcb` ||
    generator.boardSizeBytes !== boardBinding.sizeBytes ||
    generator.boardSha256 !== boardBinding.sha256
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "DIGEST_MISMATCH",
      "PCB generator report is not bound to the canonical board source.",
    );
  }
  const trackCount = integerField(generator, "track_count", "PCB generator report");
  const viaCount = integerField(generator, "via_count", "PCB generator report");
  const trackAndViaCount = integerField(generator, "track_and_via_count", "PCB generator report");
  integerField(generator, "pre_zone_fill_native_unconnected_count", "PCB generator report");
  const planeFailures = integerField(
    generator,
    "plane_connection_failure_count",
    "PCB generator report",
  );
  const unresolvedConnections = integerField(
    generator,
    "unresolved_connection_count",
    "PCB generator report",
  );
  const widthApi = isRecord(generator.width_api_check) ? generator.width_api_check : undefined;
  const hdiFinalization = isRecord(generator.sixLayerHdiFinalization)
    ? generator.sixLayerHdiFinalization
    : undefined;
  const hdiProjectRules = hdiFinalization !== undefined && isRecord(hdiFinalization.projectRules)
    ? hdiFinalization.projectRules
    : undefined;
  const removedMicrovia = hdiFinalization !== undefined && isRecord(hdiFinalization.removedRedundantMicrovia)
    ? hdiFinalization.removedRedundantMicrovia
    : undefined;
  if (
    generator.zone_fill !== "pcbnew-zone-filler-after-bound-replay" ||
    widthApi === undefined ||
    integerField(widthApi, "tracks", "Width API report") !== trackCount ||
    integerField(widthApi, "vias", "Width API report") !== viaCount ||
    !Array.isArray(generator.plane_connections) ||
    generator.plane_connections.some((row) => !isRecord(row)) ||
    !Array.isArray(generator.placements) ||
    generator.placements.some((row) => !isRecord(row)) ||
    hdiFinalization === undefined ||
    hdiFinalization.schemaVersion !== "evleda.six-layer-hdi-finalization.v1" ||
    hdiFinalization.microviaDiameterMm !== 0.26 ||
    hdiFinalization.microviaDrillMm !== 0.1 ||
    canonicalJson(hdiFinalization.microviaLayerPair) !== canonicalJson(["F.Cu", "In1.Cu"]) ||
    hdiFinalization.remainingMicroviaCount !== 11 ||
    hdiFinalization.planeZonesRefilled !== true ||
    removedMicrovia === undefined ||
    removedMicrovia.net !== "M2_FAULT" ||
    canonicalJson(removedMicrovia.positionMm) !== canonicalJson([62.1, 52.175]) ||
    hdiProjectRules === undefined ||
    hdiProjectRules.minimumMicroviaDiameterMm !== 0.26 ||
    hdiProjectRules.minimumMicroviaDrillMm !== 0.1 ||
    hdiProjectRules.minimumThroughHoleDiameterMm !== 0.2 ||
    hdiProjectRules.minimumViaAnnularWidthMm !== 0.08
  ) {
    throw staleValidation("PCB generator geometry/width evidence is malformed.");
  }
  const recomputedPlaneFailures = (
    generator.plane_connections as readonly Readonly<Record<string, unknown>>[]
  ).filter((row) => row.status !== "connected").length;
  const recomputedPlacementFailures = (
    generator.placements as readonly Readonly<Record<string, unknown>>[]
  ).filter((row) => row.status !== "placed").length;
  if (
    !Array.isArray(generator.routes) ||
    generator.routes.length === 0 ||
    generator.routes.some((row) => !isRecord(row))
  ) {
    throw staleValidation("PCB generator verified route rows are malformed.");
  }
  let verifiedPartial = 0;
  let verifiedSinglePad = 0;
  let verifiedUnresolved = 0;
  for (const route of generator.routes as readonly Readonly<Record<string, unknown>>[]) {
    const status = route.status;
    const endpointCount = integerField(route, "endpoint_count", "Verified route");
    const components = integerField(route, "connected_component_count", "Verified route");
    const unresolved = integerField(route, "unconnected_endpoint_count", "Verified route");
    const unresolvedEndpoints = integerField(route, "unresolved_endpoint_count", "Verified route");
    const routedPairs = integerField(route, "routed_pairs", "Verified route");
    if (!Array.isArray(route.failures)) throw staleValidation("Verified route failures must be an array.");
    if (status === "partial") verifiedPartial += 1;
    else if (status === "single-pad") verifiedSinglePad += 1;
    else if (status !== "routed") throw staleValidation("Verified route has an unsupported status.");
    verifiedUnresolved += unresolved;
    const structurallyValid =
      status === "single-pad"
        ? endpointCount < 2 &&
          components === endpointCount &&
          unresolved === 0 &&
          unresolvedEndpoints === 0 &&
          routedPairs === 0 &&
          route.failures.length === 0
        : status === "routed"
          ? endpointCount >= 2 &&
            components === 1 &&
            unresolved === 0 &&
            unresolvedEndpoints === 0 &&
            routedPairs === endpointCount - 1 &&
            route.failures.length === 0
          : true;
    if (!structurallyValid) throw staleValidation("Verified route component evidence is inconsistent.");
  }
  if (
    trackCount + viaCount !== trackAndViaCount ||
    trackAndViaCount <= 0 ||
    planeFailures !== recomputedPlaneFailures ||
    planeFailures !== 0 ||
    integerField(routing, "generatorUnresolvedConnectionCount", "Routing manifest") !==
      unresolvedConnections ||
    integerField(routing, "planeConnectionFailureCount", "Routing manifest") !== planeFailures ||
    unresolvedConnections !== verifiedUnresolved ||
    unresolvedConnections !== 0 ||
    integerField(generator, "partial_route_count", "PCB generator report") !== verifiedPartial ||
    integerField(generator, "single_pad_net_count", "PCB generator report") !== verifiedSinglePad ||
    integerField(routing, "partialRouteCount", "Routing manifest") !==
      integerField(generator, "partial_route_count", "PCB generator report") ||
    integerField(routing, "singlePadIntentionalNetCount", "Routing manifest") !==
      integerField(generator, "single_pad_net_count", "PCB generator report") ||
    integerField(placement, "overlapCount", "Placement manifest") !==
      integerField(generator, "unresolved_placement_count", "PCB generator report") ||
    integerField(generator, "unresolved_placement_count", "PCB generator report") !==
      recomputedPlacementFailures ||
    integerField(placement, "footprintCount", "Placement manifest", 1) !==
      integerField(generator, "footprint_count", "PCB generator report", 1) ||
    canonicalJson(placement.boardSizeMm) !== canonicalJson(generator.board_mm) ||
    canonicalJson(geometry.boardSizeMm) !== canonicalJson(generator.board_mm) ||
    integerField(geometry, "copperLayerCount", "Geometry manifest", 1) !==
      integerField(generator, "copper_layers", "PCB generator report", 1) ||
    integerField(geometry, "zoneCount", "Geometry manifest") !==
      integerField(generator, "zone_count", "PCB generator report")
  ) {
    throw staleValidation("Routing/placement counts do not agree with the bound PCB generator report.");
  }
}

async function validateGeometryAgreement(
  referenceRoot: string,
  manifest: Readonly<Record<string, unknown>>,
  sourceDigest: string,
  runRoot: string,
): Promise<void> {
  const geometry = checkRecord(manifest, "geometry");
  const binding = directBinding(geometry, "Geometry report binding");
  if (binding.path !== `${runRoot}/outputs/board-statistics.json`) {
    throw staleValidation("Geometry evidence is not bound to the declared validation run.");
  }
  const statistics = await boundJson(
    referenceRoot,
    binding,
    "Geometry report",
  );
  if (
    geometry.sourceDigest !== sourceDigest ||
    !isRecord(statistics.metadata) ||
    statistics.metadata.generator !== `KiCad ${REFERENCE_KICAD_VERSION}` ||
    statistics.metadata.project !== DESIGN_NAME ||
    statistics.metadata.board_name !== DESIGN_NAME ||
    !isRecord(statistics.board) ||
    statistics.board.has_outline !== true ||
    integerField(geometry, "copperLayerCount", "Geometry manifest", 1) !==
      ROBOTICS_CONTROLLER_V0.stackup.layerCount
  ) {
    throw staleValidation("Canonical geometry evidence does not agree with the reference design.");
  }
}

function validateGeneratorBindings(manifest: Readonly<Record<string, unknown>>): readonly FileBinding[] {
  if (!Array.isArray(manifest.generatorSourceHashes)) {
    throw staleValidation("Canonical validation generatorSourceHashes must be an array.");
  }
  const bindings = manifest.generatorSourceHashes.map((entry) =>
    directBinding(entry, "Generator source binding"),
  );
  const paths = bindings.map((binding) => binding.path);
  assertCodePointSortedUniqueStrings(paths, "Generator source bindings");
  if (canonicalJson(paths) !== canonicalJson(REFERENCE_KICAD_GENERATOR_INPUT_PATHS)) {
    throw staleValidation("Canonical validation generator inputs differ from the exact six-layer replay/evidence allowlist.");
  }
  return bindings;
}

function pathArgumentEndsWith(argument: string | undefined, expected: string): boolean {
  if (argument === undefined) return false;
  const normalized = argument.replaceAll("\\", "/");
  return normalized === expected || normalized.endsWith(`/${expected}`);
}

function positionExportSettings(args: readonly string[]): PositionExportSettings {
  const hasExactOption = (name: string, value: string): boolean => {
    const indexes = args.flatMap((argument, index) => argument === name ? [index] : []);
    return indexes.length === 1 && args[indexes[0]! + 1] === value;
  };
  const excludeDnpCount = args.filter((argument) => argument === "--exclude-dnp").length;
  if (
    !hasExactOption("--side", "both") ||
    !hasExactOption("--format", "csv") ||
    !hasExactOption("--units", "mm") ||
    excludeDnpCount > 1 ||
    args.includes("--smd-only") ||
    args.includes("--exclude-fp-th") ||
    args.includes("--variant")
  ) {
    throw staleValidation(
      "Position export invocation does not follow the bound both-side, all-footprint policy.",
    );
  }
  return {
    side: "both",
    excludeDnp: excludeDnpCount === 1,
    smdOnly: false,
    excludeFootprintsWithThroughHolePads: false,
  };
}

function validationPositionExportSettings(
  manifest: Readonly<Record<string, unknown>>,
): PositionExportSettings {
  if (!Array.isArray(manifest.invocations)) {
    throw staleValidation("Canonical validation has no position-export invocation.");
  }
  const invocations = manifest.invocations.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === "32-position",
  );
  if (invocations.length !== 1) {
    throw staleValidation("Canonical validation must contain exactly one position-export invocation.");
  }
  return positionExportSettings(
    safeStringArray(invocations[0]!.args, "Position export invocation args"),
  );
}

async function validateCommandAgreement(
  referenceRoot: string,
  manifest: Readonly<Record<string, unknown>>,
  runRoot: string,
): Promise<void> {
  const commandsBinding = directBinding(manifest.commands, "Validation command manifest binding");
  if (commandsBinding.path !== `${runRoot}/commands.json`) {
    throw staleValidation("Validation command manifest is not bound to the declared run root.");
  }
  const commandsPath = await resolveConfinedExistingFile(
    referenceRoot,
    referenceRoot,
    commandsBinding.path,
    "Validation command manifest",
  );
  let commands: unknown;
  try {
    commands = JSON.parse((await regularFileBytes(commandsPath, "Validation command manifest")).toString("utf8"));
  } catch (error) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "EVIDENCE_STALE",
      "Validation command manifest is not valid JSON.",
      {},
      false,
      { cause: error },
    );
  }
  if (!Array.isArray(commands) || canonicalJson(commands) !== canonicalJson(manifest.invocations)) {
    throw staleValidation("Bound validation commands do not agree with embedded invocations.");
  }
  if (commands.length !== EXPECTED_VALIDATION_INVOCATIONS.length) {
    throw staleValidation("Canonical validation does not contain the exact required command set.");
  }
  const capabilityHash = createHash("sha256");
  const expectedOutputs: Readonly<Record<string, string>> = {
    "10-erc": `${runRoot}/erc.json`,
    "11-drc-parity": `${runRoot}/drc.json`,
    "20-bom": `${runRoot}/outputs/bom.csv`,
    "21-netlist": `${runRoot}/outputs/schematic-netlist.kicad_net`,
    "22-schematic-svg": `${runRoot}/outputs/schematic-svg`,
    "23-schematic-pdf": `${runRoot}/outputs/schematic.pdf`,
    "30-gerbers": `${runRoot}/outputs/gerbers`,
    "31-drill": `${runRoot}/outputs/drill`,
    "32-position": `${runRoot}/outputs/positions.csv`,
    "33-render-top": `${runRoot}/outputs/board-top.png`,
    "34-render-bottom": `${runRoot}/outputs/board-bottom.png`,
    "35-board-stats": `${runRoot}/outputs/board-statistics.json`,
    "36-board-ipcd356": `${runRoot}/outputs/board-netlist.d356`,
    "37-board-svg-top": `${runRoot}/outputs/board-top.svg`,
    "38-board-svg-bottom": `${runRoot}/outputs/board-bottom.svg`,
  };
  const boundPaths = new Set(collectFileBindingRecords(manifest).map((binding) => binding.path));
  const directoryOutputs = new Set([
    `${runRoot}/outputs/schematic-svg`,
    `${runRoot}/outputs/gerbers`,
    `${runRoot}/outputs/drill`,
  ]);
  for (const [index, expected] of EXPECTED_VALIDATION_INVOCATIONS.entries()) {
    const invocation = commands[index];
    if (!isRecord(invocation)) throw staleValidation("Validation invocation is not an object.");
    const [expectedId, expectedPrefix] = expected;
    const isCheck = expectedId === "10-erc" || expectedId === "11-drc-parity";
    const expectedOutput = expectedOutputs[expectedId];
    const hasFreshTarget = expectedOutput !== undefined && !directoryOutputs.has(expectedOutput);
    const baseKeys = [
      "id",
      "args",
      "cwd",
      "exitCode",
      "startedAt",
      "finishedAt",
      "durationMs",
      "expectedExitCodes",
      "exitCodeAccepted",
      "stdout",
      "stderr",
    ];
    const expectedKeys = [
      ...baseKeys,
      ...(hasFreshTarget ? ["freshTarget"] : []),
      ...(isCheck
        ? [
            "reportValid",
            "reportError",
            "reportFindingCount",
            "expectedExitCodeFromReport",
            "commandReportAgreement",
          ]
        : []),
    ];
    assertExactKeys(invocation, expectedKeys, `Validation invocation ${expectedId}`);
    const args = safeStringArray(invocation.args, `Validation invocation ${expectedId} args`);
    const expectedExitCodes = isCheck ? [0, KICAD_DESIGN_VIOLATIONS_EXIT_CODE] : [0];
    if (
      invocation.id !== expectedId ||
      invocation.exitCode !== 0 ||
      invocation.exitCodeAccepted !== true ||
      canonicalJson(invocation.expectedExitCodes) !== canonicalJson(expectedExitCodes) ||
      typeof invocation.cwd !== "string" ||
      !path.isAbsolute(invocation.cwd) ||
      typeof invocation.startedAt !== "string" ||
      !Number.isFinite(Date.parse(invocation.startedAt)) ||
      typeof invocation.finishedAt !== "string" ||
      !Number.isFinite(Date.parse(invocation.finishedAt)) ||
      Date.parse(invocation.finishedAt) < Date.parse(invocation.startedAt) ||
      integerField(invocation, "durationMs", `Validation invocation ${expectedId}`) < 0 ||
      !expectedPrefix.every((part, partIndex) => args[partIndex] === part)
    ) {
      throw staleValidation(`Validation invocation ${expectedId} failed or used an unexpected command.`);
    }
    if (
      isCheck &&
      (invocation.reportValid !== true ||
        invocation.reportError !== null ||
        invocation.reportFindingCount !== 0 ||
        invocation.expectedExitCodeFromReport !== 0 ||
        invocation.commandReportAgreement !== true)
    ) {
      throw staleValidation(`Validation invocation ${expectedId} does not agree with its clean report.`);
    }
    const expectedCwd = expectedId === "11-drc-parity"
      ? `${runRoot}/private/drc-work`
      : `${runRoot}/isolate/reference-input`;
    if (expectedOutput !== undefined && !pathArgumentEndsWith(invocation.cwd as string, expectedCwd)) {
      throw staleValidation(`Validation invocation ${expectedId} did not use the isolated project cwd.`);
    }
    const stdout = directBinding(invocation.stdout, `${expectedId} stdout binding`, true);
    const stderr = directBinding(invocation.stderr, `${expectedId} stderr binding`, true);
    if (
      stdout.path !== `${runRoot}/logs/${expectedId}.stdout.txt` ||
      stderr.path !== `${runRoot}/logs/${expectedId}.stderr.txt`
    ) {
      throw staleValidation(`Validation invocation ${expectedId} log bindings are not canonical.`);
    }
    const [stdoutPath, stderrPath] = await Promise.all(
      [stdout, stderr].map(
        async (binding) =>
          await resolveConfinedExistingFile(
            referenceRoot,
            referenceRoot,
            binding.path,
            `${expectedId} log`,
          ),
      ),
    );
    if (stdoutPath === undefined || stderrPath === undefined) {
      throw staleValidation(`Validation invocation ${expectedId} log paths are missing.`);
    }
    const stdoutBytes = await ordinaryFileBytes(stdoutPath, `${expectedId} stdout log`, true);
    const stderrBytes = await ordinaryFileBytes(stderrPath, `${expectedId} stderr log`, true);
    if (expectedId === "00-version" && stdoutBytes.toString("utf8").trim() !== REFERENCE_KICAD_VERSION) {
      throw staleValidation("Version invocation output disagrees with the pinned KiCad version.");
    }
    const executable = isRecord(manifest.executable) ? manifest.executable : undefined;
    if (
      expectedId === "01-commit" &&
      (executable === undefined || stdoutBytes.toString("utf8").trim() !== executable.commit)
    ) {
      throw staleValidation("Commit invocation output disagrees with executable metadata.");
    }
    if (expectedId.startsWith("help-")) {
      capabilityHash.update(`${args.join("\0")}\0`);
      capabilityHash.update(stdoutBytes);
      capabilityHash.update("\n");
      capabilityHash.update(stderrBytes);
      capabilityHash.update("\0");
    }
    if (expectedOutput !== undefined) {
      const outputIndex = args.indexOf("--output");
      if (outputIndex < 0 || !pathArgumentEndsWith(args[outputIndex + 1], expectedOutput)) {
        throw staleValidation(`Validation invocation ${expectedId} is not bound to its canonical output.`);
      }
      const outputIsBound = directoryOutputs.has(expectedOutput)
        ? [...boundPaths].some((boundPath) => boundPath.startsWith(`${expectedOutput}/`))
        : boundPaths.has(expectedOutput);
      if (!outputIsBound) {
        throw staleValidation(`Validation invocation ${expectedId} has no matching output binding.`);
      }
      if (hasFreshTarget) {
        const freshTarget = invocation.freshTarget;
        if (
          !isRecord(freshTarget) ||
          freshTarget.path !== expectedOutput ||
          freshTarget.removedPreexisting !== false ||
          freshTarget.created !== true ||
          freshTarget.nonempty !== true
        ) {
          throw staleValidation(`Validation invocation ${expectedId} lacks fresh-output evidence.`);
        }
      }
      const inputName = args[0] === "sch" ? `${DESIGN_NAME}.kicad_sch` : `${DESIGN_NAME}.kicad_pcb`;
      const expectedInput =
        expectedId === "11-drc-parity"
          ? `${runRoot}/private/drc-work/${inputName}`
          : args[0] === "sch"
          ? `${runRoot}/isolate/reference-input/${inputName}`
          : `${runRoot}/evidence/drc-evaluated/${inputName}`;
      if (!args.some((argument) => pathArgumentEndsWith(argument, expectedInput))) {
        throw staleValidation(`Validation invocation ${expectedId} is not bound to its canonical source.`);
      }
    }
    const changesBoard = args.includes("--save-board") || args.includes("--refill-zones");
    if (
      (expectedId === "11-drc-parity" &&
        (!args.includes("--save-board") || !args.includes("--refill-zones"))) ||
      (expectedId !== "11-drc-parity" && changesBoard)
    ) {
      throw staleValidation(
        `Validation invocation ${expectedId} does not follow the bound refill/save policy.`,
      );
    }
    if (
      expectedId === "10-erc" &&
      !["--format", "json", "--severity-all", "--exit-code-violations"].every((token) =>
        args.includes(token),
      )
    ) {
      throw staleValidation("ERC invocation omits a required machine-readable fail-closed option.");
    }
    if (
      expectedId === "11-drc-parity" &&
      !["--format", "json", "--severity-all", "--exit-code-violations", "--schematic-parity"].every(
        (token) => args.includes(token),
      )
    ) {
      throw staleValidation("DRC invocation omits a required machine-readable parity option.");
    }
    if (expectedId === "32-position") {
      positionExportSettings(args);
    }
  }
  const executable = isRecord(manifest.executable) ? manifest.executable : undefined;
  if (
    executable === undefined ||
    executable.capabilityHelpSha256 !== capabilityHash.digest("hex") ||
    executable.identityMatchesAdapter !== true
  ) {
    throw staleValidation("Capability help logs do not agree with executable metadata.");
  }
}

function validateSourcePreservation(
  manifest: Readonly<Record<string, unknown>>,
  sourceBindings: readonly FileBinding[],
): void {
  const preservation = checkRecord(manifest, "sourcePreservation");
  if (
    preservation.unchanged !== true ||
    canonicalJson(preservation.before) !== canonicalJson(sourceBindings) ||
    canonicalJson(preservation.after) !== canonicalJson(sourceBindings)
  ) {
    throw staleValidation("Canonical source-preservation evidence does not match sourceBindings.");
  }
}

function validateExportInventory(
  manifest: Readonly<Record<string, unknown>>,
  runRoot: string,
): void {
  const exports = checkRecord(manifest, "exports");
  if (
    exports.commandsExitZero !== true ||
    exports.requiredOutputsExist !== true ||
    !Array.isArray(exports.artifacts)
  ) {
    throw staleValidation("Canonical validation is missing a complete export inventory.");
  }
  const artifacts = exports.artifacts.map((entry) => directBinding(entry, "Export artifact binding"));
  const paths = artifacts.map((artifact) => artifact.path);
  assertCodePointSortedUniqueStrings(paths, "Export artifact paths");
  const required = [
    `${runRoot}/outputs/bom.csv`,
    `${runRoot}/outputs/schematic-netlist.kicad_net`,
    `${runRoot}/outputs/board-statistics.json`,
    `${runRoot}/outputs/board-netlist.d356`,
    `${runRoot}/outputs/board-top.png`,
    `${runRoot}/outputs/board-bottom.png`,
    `${runRoot}/outputs/positions.csv`,
  ];
  if (
    paths.some((candidate) => !candidate.startsWith(`${runRoot}/outputs/`)) ||
    required.some((requiredPath) => !paths.includes(requiredPath)) ||
    !paths.some((candidate) => candidate.startsWith(`${runRoot}/outputs/gerbers/`)) ||
    !paths.some((candidate) => candidate.startsWith(`${runRoot}/outputs/drill/`))
  ) {
    throw staleValidation("Canonical validation export inventory is incomplete.");
  }
}

async function validateCanonicalReference(
  rawReferenceRoot: string,
): Promise<ValidatedCanonicalReference> {
  const nativeContractAuthority = await snapshotReferenceControllerRevANativeAuthority();
  try {
  if (!path.isAbsolute(rawReferenceRoot)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_UNAVAILABLE",
      "INVALID_ARGUMENT",
      "Reference design root must be an absolute path.",
    );
  }
  const originalMetadata = await lstat(path.resolve(rawReferenceRoot));
  if (originalMetadata.isSymbolicLink()) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_UNAVAILABLE",
      "TOOLCHAIN_UNAVAILABLE",
      "Reference design root must not be a symbolic link.",
    );
  }
  const referenceRoot = await resolveExistingDirectory(rawReferenceRoot, "Reference design root");
  for (const sourcePath of REQUIRED_SOURCE_PATHS) {
    await resolveConfinedExistingFile(referenceRoot, referenceRoot, sourcePath, sourcePath);
  }
  const validationPath = path.join(referenceRoot, "validation", "reference-validation.json");
  let validationBytes: Buffer;
  try {
    validationBytes = await regularFileBytes(validationPath, "Canonical reference validation");
  } catch (error) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_MISSING",
      "EVIDENCE_MISSING",
      "Canonical reference-validation.json is absent or unreadable.",
      { path: validationPath },
      false,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(validationBytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "EVIDENCE_STALE",
      "Canonical reference validation is not valid JSON.",
      {},
      false,
      { cause: error },
    );
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== REFERENCE_VALIDATION_SCHEMA) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_VALIDATION_STALE",
      "EVIDENCE_STALE",
      `Canonical reference validation must use ${REFERENCE_VALIDATION_SCHEMA}.`,
    );
  }
  assertExactKeys(
    parsed,
    [
      "schemaVersion",
      "design",
      "lifecycle",
      "releaseAuthorized",
      "checksPass",
      "createdAt",
      "sourceDigest",
      "sourceBindings",
      "validationInputBindings",
      "validationInputPreservation",
      "generatorSourceDigest",
      "generatorSourceHashes",
      "generatorSourcePreservation",
      "run",
      "executable",
      "invocations",
      "erc",
      "drc",
      "routing",
      "placement",
      "connectivity",
      "geometry",
      "exports",
      "commands",
      "sourcePreservation",
      "regeneration",
      "unresolvedAssumptions",
      "validationRoot",
    ],
    "Canonical reference validation",
  );
  if (
    parsed.design !== DESIGN_NAME ||
    typeof parsed.checksPass !== "boolean" ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt))
  ) {
    throw staleValidation("Canonical reference validation has invalid identity/status metadata.");
  }
  const root = validationRootRecord(parsed);
  validateExecutableManifest(parsed.executable);
  const sourceBindings = validateSourceBindings(parsed.sourceBindings, parsed.sourceDigest);
  await validateProjectLocalLibraryBindings(referenceRoot, sourceBindings);
  const runRoot = validatedRunRoot(parsed);
  validateIsolatedInputBindings(parsed, sourceBindings, runRoot);
  validateGeneratorSourceAgreement(parsed);
  const fileBindings = await verifyManifestFileBindings(
    referenceRoot,
    parsed,
    nativeContractAuthority,
  );
  const generatorBindings = validateGeneratorBindings(parsed);
  const erc = checkRecord(parsed, "erc");
  const drc = checkRecord(parsed, "drc");
  assertZeroCount(erc, ["violationCount", "findingCount", "violations"], "ERC");
  assertZeroCount(drc, ["violationCount", "findingCount", "violations"], "DRC");
  assertZeroCount(drc, ["schematicParityCount", "parityCount"], "schematic parity");
  assertZeroCount(drc, ["unconnectedCount", "unroutedCount"], "unrouted");

  const routing = checkRecord(parsed, "routing");
  assertZeroCount(routing, ["partialRouteCount", "partialRoutes"], "partial route");
  assertZeroCount(routing, ["unroutedCount", "unrouted"], "unrouted");
  const placement = checkRecord(parsed, "placement");
  assertZeroCount(placement, ["overlapCount", "placementOverlapCount"], "placement overlap");
  if (
    parsed.lifecycle !== "candidate" ||
    parsed.releaseAuthorized !== false ||
    parsed.checksPass !== true
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_NATIVE_FINDINGS",
      "GATE_FAILED",
      "Canonical reference validation is not a passing candidate-only validation.",
      {
        lifecycle: parsed.lifecycle,
        releaseAuthorized: parsed.releaseAuthorized,
        checksPass: parsed.checksPass,
      },
    );
  }

  const qualificationOnlyAssumptions = validateQualificationAssumptions(
    parsed.unresolvedAssumptions,
  );
  const regeneration = await validateRegeneration(
    referenceRoot,
    parsed.regeneration,
    parsed.sourceDigest as string,
    sourceBindings,
    parsed.generatorSourceDigest as string,
    generatorBindings,
    parsed.executable,
  );
  validateSourcePreservation(parsed, sourceBindings);
  await validateNativeReportAgreement(
    referenceRoot,
    parsed,
    parsed.sourceDigest as string,
    sourceBindings,
    runRoot,
  );
  await validateConnectivityAgreement(
    referenceRoot,
    parsed,
    parsed.sourceDigest as string,
    runRoot,
    nativeContractAuthority,
  );
  await validateComponentMetadataAgreement(
    referenceRoot,
    parsed,
    parsed.sourceDigest as string,
    sourceBindings,
    runRoot,
  );
  await validateRoutingPlacementAgreement(referenceRoot, parsed, sourceBindings, runRoot);
  await validateGeometryAgreement(referenceRoot, parsed, parsed.sourceDigest as string, runRoot);
  validateExportInventory(parsed, runRoot);
  await validateCommandAgreement(referenceRoot, parsed, runRoot);

  const snapshotPaths = sortedUnique([
    ...fileBindings.map((binding) => binding.path),
    "validation/reference-validation.json",
  ]);
  const snapshot = new Map<string, FileBinding>();
  for (const relativePath of snapshotPaths) {
    const filePath = await resolveConfinedExistingFile(
      referenceRoot,
      referenceRoot,
      relativePath,
      `Reference snapshot ${relativePath}`,
    );
    snapshot.set(relativePath, await bindingFor(filePath, relativePath, true));
  }
  return {
    referenceRoot,
    validationPath,
    validationIdentity: contentIdentity(validationBytes),
    validationDocument: parsed,
    validationRoot: root,
    nativeContractAuthority,
    sourceBindings,
    qualificationOnlyAssumptions,
    regeneration,
    snapshot,
  };
  } finally {
    await reverifyReferenceControllerRevANativeAuthority(nativeContractAuthority);
  }
}

async function assertSnapshotUnchanged(canonical: ValidatedCanonicalReference): Promise<void> {
  const changed: string[] = [];
  for (const [relativePath, before] of canonical.snapshot) {
    try {
      const filePath = await resolveConfinedExistingFile(
        canonical.referenceRoot,
        canonical.referenceRoot,
        relativePath,
        `Reference snapshot ${relativePath}`,
      );
      const after = await bindingFor(filePath, relativePath, true);
      if (after.sha256 !== before.sha256 || after.sizeBytes !== before.sizeBytes) changed.push(relativePath);
    } catch {
      changed.push(relativePath);
    }
  }
  if (changed.length > 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_MUTATED",
      "ARTIFACT_INTEGRITY_ERROR",
      `Canonical reference changed during backend execution: ${changed.join(", ")}.`,
      { changedPaths: changed },
      true,
    );
  }
}

function requestedProfileParameters(profile: unknown): ReferenceControllerParameters | undefined {
  if (!isRecord(profile)) return undefined;
  const inputVoltageMv = profile.inputVoltageMv;
  const motor = profile.motor;
  const stackup = profile.stackup;
  const interfaceSelections = profile.interfaceSelections;
  if (
    typeof profile.boardRevision !== "string" ||
    !isRecord(inputVoltageMv) ||
    typeof inputVoltageMv.minimum !== "number" ||
    typeof inputVoltageMv.maximum !== "number" ||
    !isRecord(motor) ||
    typeof motor.channels !== "number" ||
    typeof motor.rmsCurrentMaPerChannel !== "number" ||
    typeof motor.currentChopMaPerChannel !== "number" ||
    !isRecord(stackup) ||
    typeof stackup.layerCount !== "number" ||
    !Array.isArray(stackup.layers) ||
    stackup.layers.some((layer) => typeof layer !== "string") ||
    !Array.isArray(interfaceSelections) ||
    interfaceSelections.some((name) => typeof name !== "string")
  ) {
    return undefined;
  }
  return {
    boardRevision: profile.boardRevision,
    inputVoltageMv: {
      minimum: inputVoltageMv.minimum,
      maximum: inputVoltageMv.maximum,
    },
    motor: {
      channels: motor.channels,
      rmsCurrentMaPerChannel: motor.rmsCurrentMaPerChannel,
      currentChopMaPerChannel: motor.currentChopMaPerChannel,
    },
    stackup: {
      layerCount: stackup.layerCount,
      layers: [...stackup.layers] as string[],
    },
    interfaceSelections:
      interfaceSelections as NonNullable<ReferenceControllerParameters["interfaceSelections"]>,
  };
}

function assertSupportedTemplateProfile(
  profile: unknown,
): asserts profile is ReferenceControllerProfile {
  const parameters = requestedProfileParameters(profile);
  if (parameters === undefined) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_PROFILE_UNSUPPORTED",
      "TOOLCHAIN_UNSUPPORTED",
      "Reference profile is not a complete parameterized robotics-controller-v0 request.",
      { unsupportedReasons: ["PROFILE_SHAPE_INVALID"] },
    );
  }

  const canonicalInstantiation = createReferenceControllerProfile(parameters);
  if (canonicalInstantiation.parameterValidation.supportStatus !== "supported") {
    throw new ReferenceKicadBackendError(
      "REFERENCE_PROFILE_UNSUPPORTED",
      "TOOLCHAIN_UNSUPPORTED",
      "Requested electrical envelope or topology is outside the reviewed Rev-A template.",
      {
        profileId: isRecord(profile) ? profile.profileId : undefined,
        boardRevision: parameters.boardRevision,
        unsupportedReasons: canonicalInstantiation.parameterValidation.unsupportedReasons,
      },
    );
  }

  let suppliedCanonical: string;
  try {
    suppliedCanonical = canonicalJson(profile);
  } catch (error) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_PROFILE_UNSUPPORTED",
      "TOOLCHAIN_UNSUPPORTED",
      "Reference profile cannot be represented as the canonical reviewed-template contract.",
      { unsupportedReasons: ["PROFILE_CANONICALIZATION_FAILED"] },
      false,
      { cause: error },
    );
  }
  if (suppliedCanonical !== canonicalJson(canonicalInstantiation)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_PROFILE_UNSUPPORTED",
      "TOOLCHAIN_UNSUPPORTED",
      "Reference profile changes a structural or derived Rev-A invariant. Only the canonical factory's narrowed voltage/current instantiation may reuse the native design.",
      {
        profileId: isRecord(profile) ? profile.profileId : undefined,
        boardRevision: parameters.boardRevision,
        unsupportedReasons: ["PROFILE_NOT_CANONICAL_REVIEWED_TEMPLATE_INSTANTIATION"],
        suppliedProfileIdentity: canonicalIdentity(
          profile,
          REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
        ),
        canonicalInstantiationIdentity: canonicalIdentity(
          canonicalInstantiation,
          REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
        ),
      },
    );
  }
}

function sameExactIdentity(
  left: ContentIdentity | CanonicalIdentity,
  right: ContentIdentity | CanonicalIdentity,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function referenceCanonicalSnapshotIdentity(document: unknown): CanonicalIdentity {
  if (!isRecord(document) || typeof document.schemaVersion !== "string") {
    throw new Error("Snapshot document lacks a schema version");
  }
  const {
    identity: _identity,
    captureIdentity: _captureIdentity,
    ...payload
  } = document;
  return canonicalIdentity(
    "identity" in document || "captureIdentity" in document ? payload : document,
    document.schemaVersion,
  );
}

function assertReferenceSnapshotBinding(snapshot: {
  readonly logicalName: string;
  readonly document: unknown;
  readonly contentIdentity: ContentIdentity;
  readonly canonicalIdentity: CanonicalIdentity;
}): void {
  if (!isSafeLogicalPath(snapshot.logicalName)) throw new Error("Unsafe snapshot path");
  const canonical = referenceCanonicalSnapshotIdentity(snapshot.document);
  const content = contentIdentity(
    Buffer.from(`${canonicalJson(snapshot.document)}\n`, "utf8"),
  );
  const embeddedIdentity = isRecord(snapshot.document) && "identity" in snapshot.document
    ? snapshot.document.identity
    : undefined;
  if (
    !sameExactIdentity(canonical, snapshot.canonicalIdentity) ||
    !sameExactIdentity(content, snapshot.contentIdentity) ||
    (embeddedIdentity !== undefined &&
      canonicalJson(embeddedIdentity) !== canonicalJson(snapshot.canonicalIdentity))
  ) {
    throw new Error("Snapshot identity mismatch");
  }
}

function assertReferenceRoutePolicyCapture(
  snapshot: {
    readonly document: Readonly<Record<string, unknown>>;
    readonly captureIdentity: ContentIdentity;
  },
): void {
  const {
    identity: _identity,
    captureIdentity: _captureIdentity,
    ...payload
  } = snapshot.document;
  const capture = contentIdentity(Buffer.from(`${canonicalJson(payload)}\n`, "utf8"));
  if (
    !sameExactIdentity(capture, snapshot.captureIdentity) ||
    canonicalJson(snapshot.document.captureIdentity) !== canonicalJson(snapshot.captureIdentity)
  ) {
    throw new Error("Route-quality policy capture identity mismatch");
  }
}

function assertPcbEngineeringRequest(request: KicadBackendRequest): void {
  const binding = request.pcbEngineering;
  if (request.stage !== "pcb_placement_routing") {
    if (binding !== null) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_REQUEST_INVALID",
        "INVALID_ARGUMENT",
        "PCB engineering-analysis inputs are only valid for PCB placement/routing.",
      );
    }
    return;
  }
  if (binding === null) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_REQUEST_INVALID",
      "INVALID_ARGUMENT",
      "PCB placement/routing requires exact plan, analyzer-profile, and practice-catalog bindings.",
    );
  }
  try {
    const catalog = validateAndSnapshotPcbEngineeringPracticeCatalog(
      binding.practiceCatalog.document,
    );
    const plan = binding.layoutPlan.document;
    const planIdentity = contentIdentity(
      Buffer.from(`${canonicalJson(plan)}\n`, "utf8"),
    );
    for (const snapshot of [
      binding.analyzerProfile,
      binding.practiceCatalog,
      binding.routeQualityPolicy,
      binding.routeQualityRuleDeck,
      binding.proofFixturePolicy,
      ...(binding.engineeringConstraintBinding === null
        ? []
        : [binding.engineeringConstraintBinding]),
    ]) {
      assertReferenceSnapshotBinding(snapshot);
    }
    assertReferenceRoutePolicyCapture(binding.routeQualityPolicy);
    const practiceBinding = isRecord(plan.practiceBinding)
      ? plan.practiceBinding
      : undefined;
    if (
      !isSafeLogicalPath(binding.layoutPlan.logicalName) ||
      plan.schemaVersion !== "evleda.pcb-layout-plan.v2" ||
      plan.profileId !== request.profile.profileId ||
      plan.boardRevision !== request.profile.boardRevision ||
      plan.lifecycle !== "candidate" ||
      plan.releaseAuthorized !== false ||
      practiceBinding === undefined ||
      !sameExactIdentity(
        practiceBinding.catalogIdentity as CanonicalIdentity,
        binding.practiceCatalog.canonicalIdentity,
      ) ||
      !sameExactIdentity(planIdentity, binding.layoutPlan.contentIdentity) ||
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
      )
    ) {
      throw new Error("PCB engineering binding identity mismatch");
    }
    if (binding.engineeringConstraintBinding !== null) {
      const trustedConstraintBinding = validateAndSnapshotEngineeringConstraintBinding(
        binding.engineeringConstraintBinding.document,
      );
      if (
        canonicalJson(trustedConstraintBinding) !==
          canonicalJson(binding.engineeringConstraintBinding.document) ||
        !sameExactIdentity(
          trustedConstraintBinding.catalogIdentity,
          binding.practiceCatalog.canonicalIdentity,
        ) ||
        !sameExactIdentity(
          trustedConstraintBinding.identity,
          binding.engineeringConstraintBinding.canonicalIdentity,
        )
      ) {
        throw new Error("Compiled engineering constraint-set identity mismatch");
      }
    }
  } catch (error) {
    if (error instanceof ReferenceKicadBackendError) throw error;
    throw new ReferenceKicadBackendError(
      "REFERENCE_REQUEST_INVALID",
      "INVALID_ARGUMENT",
      "PCB engineering-analysis documents or identities do not reproduce at the reference backend boundary.",
      {},
      false,
      { cause: error },
    );
  }
}

function assertRequest(request: KicadBackendRequest): void {
  if (
    request.schemaVersion !== "evleda.kicad-request.v2" ||
    !/^[0-9a-f]{64}$/u.test(request.expectedSourceRevisionDigest)
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_REQUEST_INVALID",
      "INVALID_ARGUMENT",
      "Reference KiCad backend requires a v2 request and lowercase SHA-256 source revision digest.",
    );
  }
  assertPcbEngineeringRequest(request);
  assertSupportedTemplateProfile(request.profile);
  for (const identity of request.upstreamArtifactIdentities) {
    if (
      identity.algorithm !== "sha256" ||
      !/^[0-9a-f]{64}$/u.test(identity.digest) ||
      !Number.isSafeInteger(identity.size) ||
      identity.size < 0
    ) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_REQUEST_INVALID",
        "INVALID_ARGUMENT",
        "Upstream artifact identities must be exact SHA-256 content identities.",
      );
    }
  }
  assertRequirements(request.requirements, request.profile);
}

function requirementsIdentityPayload(document: RequirementsDocument): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: document.schemaVersion,
    sourcePrompt: document.sourcePrompt,
    requirements: document.requirements,
    constraints: document.constraints,
    exclusions: document.exclusions,
    unresolvedAssumptions: document.unresolvedAssumptions,
  };
}

function assertRequirements(
  document: RequirementsDocument,
  profile: ReferenceControllerProfile,
): void {
  const recomputed = canonicalIdentity(requirementsIdentityPayload(document), "evleda.requirements.v1");
  const constraints = document.constraints;
  const requiredInterfaces = ["USB", "CAN", "UART", "I2C", "SPI", "SWD", "quadrature encoder"];
  const normalizedValues = new Set(
    document.requirements.map((requirement) => requirement.normalizedValue).filter((value) => value !== undefined),
  );
  const valid =
    document.schemaVersion === "evleda.requirements.v1" &&
    document.identity.algorithm === "sha256" &&
    document.identity.schemaVersion === "evleda.requirements.v1" &&
    document.identity.canonicalizationVersion === "evleda-c14n-json-v1" &&
    document.identity.digest === recomputed.digest &&
    document.sourcePrompt.algorithm === "sha256" &&
    /^[0-9a-f]{64}$/u.test(document.sourcePrompt.digest) &&
    Number.isSafeInteger(document.sourcePrompt.size) &&
    document.sourcePrompt.size > 0 &&
    constraints.reference_profile === DESIGN_NAME &&
    constraints.input_voltage_min_mv === String(profile.inputVoltageMv.minimum) &&
    constraints.input_voltage_max_mv === String(profile.inputVoltageMv.maximum) &&
    constraints.motor_channels === String(profile.motor.channels) &&
    constraints.motor_current_rms_ma === String(profile.motor.rmsCurrentMaPerChannel) &&
    document.unresolvedAssumptions.every((assumption) => assumption.severity !== "blocking") &&
    requiredInterfaces.every((name) => normalizedValues.has(name));
  if (!valid) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_REQUIREMENTS_UNSUPPORTED",
      "TOOLCHAIN_UNSUPPORTED",
      "Requirements do not exactly match the complete, unambiguous requested robotics-controller-v0 envelope.",
      {
        requirementsDigest: document.identity.digest,
        requestedProfileIdentity: canonicalIdentity(
          profile,
          REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
        ),
        requestedElectricalEnvelope: electricalEnvelope(profile),
      },
    );
  }
}

async function copyBoundFileWithoutLinks(
  sourceRoot: string,
  targetRoot: string,
  expected: FileBinding,
): Promise<void> {
  const source = path.join(sourceRoot, expected.path);
  assertPathWithin(sourceRoot, source, "Reference copy source", false);
  const sourceMetadata = await lstat(source);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile() || sourceMetadata.nlink !== 1) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_UNAVAILABLE",
      "TOOLCHAIN_UNAVAILABLE",
      `Reference copy source must be a single-link ordinary file: ${expected.path}.`,
    );
  }
  const target = path.join(targetRoot, expected.path);
  assertPathWithin(targetRoot, target, "Reference copy destination", false);
  await mkdir(path.dirname(target), { recursive: true });

  const sourceHandle = await open(source, "r");
  let bytes: Buffer;
  try {
    const openedMetadata = await sourceHandle.stat();
    if (!openedMetadata.isFile() || openedMetadata.nlink !== 1) {
      throw staleValidation(`Opened reference source is not an ordinary file: ${expected.path}.`);
    }
    bytes = await sourceHandle.readFile();
  } finally {
    await sourceHandle.close();
  }
  const sourceIdentity = contentIdentity(bytes);
  if (sourceIdentity.digest !== expected.sha256 || sourceIdentity.size !== expected.sizeBytes) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_MUTATED",
      "DIGEST_MISMATCH",
      `Reference source changed before its isolated copy was captured: ${expected.path}.`,
      { expected, actual: sourceIdentity },
      true,
    );
  }

  const targetHandle = await open(target, "wx");
  try {
    await targetHandle.writeFile(bytes);
    await targetHandle.sync();
    const targetMetadata = await targetHandle.stat();
    if (!targetMetadata.isFile() || targetMetadata.nlink !== 1) {
      throw staleValidation(`Isolated copy target is not an ordinary file: ${expected.path}.`);
    }
  } finally {
    await targetHandle.close();
  }
  const canonicalTarget = await realpath(target);
  assertPathWithin(targetRoot, canonicalTarget, "Reference copy destination", false);
  const copied = await bindingFor(canonicalTarget, expected.path);
  if (copied.sha256 !== expected.sha256 || copied.sizeBytes !== expected.sizeBytes) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_MUTATED",
      "ARTIFACT_INTEGRITY_ERROR",
      `Working-copy byte verification failed for ${expected.path}.`,
      { expected, actual: copied },
    );
  }
}

async function createWorkingCopy(
  canonical: ValidatedCanonicalReference,
  workRoot: string,
): Promise<WorkingCopy> {
  const runRoot = await mkdtemp(path.join(workRoot, "evleda-reference-kicad-"));
  assertPathWithin(workRoot, runRoot, "Reference KiCad working directory", false);
  try {
    const projectRoot = path.join(runRoot, "project");
    await mkdir(projectRoot);
    for (const binding of canonical.sourceBindings) {
      await copyBoundFileWithoutLinks(canonical.referenceRoot, projectRoot, binding);
    }
    const runMetadata = await stat(runRoot);
    return {
      runRoot,
      runDevice: runMetadata.dev,
      runInode: runMetadata.ino,
      projectRoot,
      projectPath: path.join(projectRoot, `${DESIGN_NAME}.kicad_pro`),
      schematicPath: path.join(projectRoot, `${DESIGN_NAME}.kicad_sch`),
      pcbPath: path.join(projectRoot, `${DESIGN_NAME}.kicad_pcb`),
    };
  } catch (error) {
    try {
      await rm(runRoot, { recursive: true, force: false });
    } catch (cleanupError) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_WORKSPACE_CLEANUP_FAILED",
        "ARTIFACT_INTEGRITY_ERROR",
        "Failed to clean an incomplete Reference KiCad working copy.",
        { workingDirectory: runRoot },
        false,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

function unescapeKicadString(value: string): string {
  return value.replace(/\\([\\"])/gu, "$1");
}

function sExpressionForms(source: string, name: string): readonly string[] {
  const forms: string[] = [];
  const marker = `(${name}`;
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    const boundary = source[start + marker.length];
    if (boundary !== undefined && !/[\s)]/u.test(boundary)) {
      cursor = start + marker.length;
      continue;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_CONNECTIVITY_FAILED",
        "TOOL_RESULT_INCONCLUSIVE",
        `KiCad schematic netlist contains an unterminated ${name} form.`,
      );
    }
    forms.push(source.slice(start, end));
    cursor = end;
  }
  return forms;
}

function netlistStringField(form: string, field: string): string | null {
  const match = new RegExp(`\\(${field}\\s+"((?:\\\\.|[^"\\\\])*)"\\)`, "u").exec(form);
  return match?.[1] === undefined ? null : unescapeKicadString(match[1]);
}

function netlistNamedProperty(form: string, propertyName: string): string | null {
  const matches = sExpressionForms(form, "property").flatMap((propertyForm) => {
    const name = netlistStringField(propertyForm, "name");
    const value = netlistStringField(propertyForm, "value");
    return name === propertyName && value !== null ? [value] : [];
  });
  if (matches.length > 1) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "GATE_FAILED",
      `KiCad schematic component contains duplicate ${propertyName} properties.`,
    );
  }
  return matches[0] ?? null;
}

function parseSchematicNetlist(bytes: Uint8Array): {
  readonly references: readonly string[];
  readonly netNames: readonly string[];
  readonly nodes: readonly KicadNetlistNode[];
  readonly components: readonly NativeComponentMetadata[];
} {
  const source = Buffer.from(bytes).toString("utf8");
  if (!source.trimStart().startsWith("(export")) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_CONNECTIVITY_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad schematic netlist has an unsupported format.",
    );
  }
  const components = sExpressionForms(source, "comp").map((form) => {
    const reference = netlistStringField(form, "ref");
    const value = netlistStringField(form, "value");
    const footprint = netlistStringField(form, "footprint");
    if (reference === null || reference.length === 0) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_COMPONENT_METADATA_FAILED",
        "GATE_FAILED",
        "KiCad schematic component is missing an exact reference.",
      );
    }
    return {
      reference,
      value,
      footprint,
      partNumber: netlistNamedProperty(form, "MPN"),
    };
  });
  const references = components.map((component) => component.reference);
  const netsForms = sExpressionForms(source, "nets");
  if (netsForms.length !== 1) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_CONNECTIVITY_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad schematic netlist must contain exactly one nets form.",
      { netsFormCount: netsForms.length },
    );
  }
  const netForms = sExpressionForms(netsForms[0]!, "net");
  const netNames: string[] = [];
  const nodes: KicadNetlistNode[] = [];
  for (const netForm of netForms) {
    const netName = netlistStringField(netForm, "name");
    if (netName === null || netName.length === 0) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_CONNECTIVITY_FAILED",
        "TOOL_RESULT_INCONCLUSIVE",
        "KiCad schematic netlist contains a net without a name.",
      );
    }
    netNames.push(netName);
    for (const nodeForm of sExpressionForms(netForm, "node")) {
      const reference = netlistStringField(nodeForm, "ref");
      const pin = netlistStringField(nodeForm, "pin");
      if (reference === null || reference.length === 0 || pin === null || pin.length === 0) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_CONNECTIVITY_FAILED",
          "TOOL_RESULT_INCONCLUSIVE",
          "KiCad schematic netlist contains a node without an exact reference and pin.",
        );
      }
      nodes.push({
        reference,
        pin,
        pinFunction: netlistStringField(nodeForm, "pinfunction"),
        pinType: netlistStringField(nodeForm, "pintype"),
        netName,
      });
    }
  }
  if (
    references.length === 0 ||
    netNames.length === 0 ||
    sortedUnique(references).length !== references.length ||
    sortedUnique(netNames).length !== netNames.length
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_CONNECTIVITY_FAILED",
      "GATE_FAILED",
      "KiCad schematic netlist is empty or contains duplicate component/net identities.",
      { componentCount: references.length, netCount: netNames.length },
    );
  }
  const observedNets = new Set(netNames);
  const missingRequiredNets = REFERENCE_KICAD_REQUIRED_NETS.filter((netName) =>
    !observedNets.has(netName),
  );
  if (missingRequiredNets.length > 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_CONNECTIVITY_FAILED",
      "GATE_FAILED",
      "KiCad schematic netlist is missing required robotics-controller-v0 connectivity.",
      { missingRequiredNets },
    );
  }
  const nodeKeys = nodes.map((node) => `${node.reference}\u0000${node.pin}`);
  if (new Set(nodeKeys).size !== nodeKeys.length) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_CONNECTIVITY_FAILED",
      "GATE_FAILED",
      "KiCad schematic netlist assigns at least one component pin to multiple nets.",
    );
  }
  assertReferenceSetAgreement({
    observed: sortedUnique(nodes.map((node) => node.reference)),
    expected: references,
    relationship: "observed_subset",
    source: "KiCad schematic netlist node",
    expectedSource: "the declared schematic component set",
    failureCode: "REFERENCE_CONNECTIVITY_FAILED",
  });
  return {
    references: sortedUnique(references),
    netNames: sortedUnique(netNames),
    components,
    nodes: [...nodes].sort((left, right) => {
      const leftKey = `${left.reference}\u0000${left.pin}\u0000${left.netName}`;
      const rightKey = `${right.reference}\u0000${right.pin}\u0000${right.netName}`;
      return leftKey.localeCompare(rightKey, "en-US");
    }),
  };
}

function parsePcbReferences(boardBytes: Uint8Array): readonly string[] {
  return pcbPositionReferenceSource(parsePcbComponents(boardBytes)).pcbReferences;
}

function pcbFootprintProperty(form: string, propertyName: string): string | null {
  const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...form.matchAll(
    new RegExp(`\\(property\\s+"${escapedName}"\\s+"((?:\\\\.|[^"\\\\])*)"`, "gu"),
  )];
  if (matches.length > 1) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "GATE_FAILED",
      `KiCad PCB footprint contains duplicate ${propertyName} properties.`,
    );
  }
  const encoded = matches[0]?.[1];
  return encoded === undefined ? null : unescapeKicadString(encoded);
}

function pcbFootprintAttributeTokens(form: string): readonly string[] {
  const attributeForms = sExpressionForms(form, "attr");
  if (attributeForms.length > 1) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "GATE_FAILED",
      "KiCad PCB footprint contains multiple attribute forms.",
    );
  }
  const attributeForm = attributeForms[0];
  if (attributeForm === undefined) return [];
  const body = attributeForm.slice("(attr".length, -1).trim();
  if (body.length === 0) return [];
  if (/[()"]|[^\x20-\x7e]/u.test(body)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "GATE_FAILED",
      "KiCad PCB footprint contains malformed attributes.",
    );
  }
  const tokens = body.split(/\s+/u);
  if (sortedUnique(tokens).length !== tokens.length) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "GATE_FAILED",
      "KiCad PCB footprint contains duplicate attributes.",
    );
  }
  return tokens;
}

function parsePcbComponents(boardBytes: Uint8Array): readonly NativePcbComponentMetadata[] {
  const source = Buffer.from(boardBytes).toString("utf8");
  if (!source.trimStart().startsWith("(kicad_pcb")) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad PCB component metadata has an unsupported source format.",
    );
  }
  const components = sExpressionForms(source, "footprint").map((form) => {
    const footprintMatch = /^\(footprint\s+"((?:\\.|[^"\\])+)"/u.exec(form);
    const reference = pcbFootprintProperty(form, "Reference");
    const value = pcbFootprintProperty(form, "Value");
    if (
      footprintMatch?.[1] === undefined ||
      reference === null ||
      reference.length === 0 ||
      value === null ||
      value.length === 0
    ) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_COMPONENT_METADATA_FAILED",
        "GATE_FAILED",
        "KiCad PCB footprint is missing an exact library ID, reference, or value.",
      );
    }
    const attributes = pcbFootprintAttributeTokens(form);
    const positionExclusionReasons: PositionReferenceExclusionReason[] = [];
    if (attributes.includes("exclude_from_pos_files")) {
      positionExclusionReasons.push("exclude_from_position_files");
    }
    if (attributes.includes("dnp")) positionExclusionReasons.push("do_not_populate");
    if (attributes.includes("virtual")) positionExclusionReasons.push("legacy_virtual");
    return {
      reference,
      value,
      footprint: unescapeKicadString(footprintMatch[1]),
      partNumber: pcbFootprintProperty(form, "MPN"),
      positionExclusionReasons,
    };
  });
  const references = components.map((component) => component.reference);
  if (components.length === 0 || sortedUnique(references).length !== references.length) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "GATE_FAILED",
      "KiCad PCB has no unique component metadata set.",
      { footprintCount: components.length },
    );
  }
  return components;
}

function pcbPositionReferenceSource(
  components: readonly NativePcbComponentMetadata[],
): PcbPositionReferenceSource {
  const references = components.map((component) => component.reference);
  const pcbReferences = assertReferenceSetAgreement({
    observed: references,
    expected: references,
    relationship: "exact",
    source: "KiCad PCB footprint",
    expectedSource: "a unique PCB footprint reference set",
    failureCode: "REFERENCE_CONNECTIVITY_FAILED",
  });
  const pcbDnpReferences = sortedUnique(
    components
      .filter((component) => component.positionExclusionReasons.includes("do_not_populate"))
      .map((component) => component.reference),
  );
  const footprintExcludedReferences = components
    .map((component) => ({
      reference: component.reference,
      reasons: component.positionExclusionReasons.filter(
        (reason): reason is Exclude<PositionReferenceExclusionReason, "do_not_populate"> =>
          reason !== "do_not_populate",
      ),
    }))
    .filter((component) => component.reasons.length > 0)
    .sort((left, right) => left.reference.localeCompare(right.reference, "en-US"));
  return { pcbReferences, pcbDnpReferences, footprintExcludedReferences };
}

function pcbPositionReferencePolicy(
  source: PcbPositionReferenceSource,
  settings: PositionExportSettings,
  bomDnpReferences: readonly string[],
): PcbPositionReferencePolicy {
  const canonicalBomDnpReferences = assertReferenceSetAgreement({
    observed: bomDnpReferences,
    expected: source.pcbDnpReferences,
    relationship: "exact",
    source: "KiCad BOM DNP",
    expectedSource: "the PCB DNP attribute set",
    failureCode: "REFERENCE_POSITION_PARITY_FAILED",
  });
  const exclusions = new Map<
    string,
    PositionReferenceExclusionReason[]
  >(source.footprintExcludedReferences.map((entry) => [
    entry.reference,
    [...entry.reasons],
  ]));
  if (settings.excludeDnp) {
    for (const reference of canonicalBomDnpReferences) {
      const reasons = exclusions.get(reference) ?? [];
      reasons.push("do_not_populate");
      exclusions.set(reference, reasons);
    }
  }
  const deliberatelyExcludedReferences = [...exclusions]
    .map(([reference, reasons]) => ({ reference, reasons }))
    .sort((left, right) => left.reference.localeCompare(right.reference, "en-US"));
  const excluded = new Set(
    deliberatelyExcludedReferences.map((component) => component.reference),
  );
  return {
    ...settings,
    pcbReferences: source.pcbReferences,
    pcbDnpReferences: source.pcbDnpReferences,
    bomDnpReferences: canonicalBomDnpReferences,
    expectedPositionReferences: source.pcbReferences.filter((reference) => !excluded.has(reference)),
    deliberatelyExcludedReferences,
  };
}

export function assertReferencePcbComponentMetadata(
  boardBytes: Uint8Array,
  profile: ReferenceControllerProfile,
): readonly ReferenceSelectedComponentMetadata[] {
  return assertReferenceSelectedComponentMetadata(parsePcbComponents(boardBytes), profile, "KiCad PCB");
}

export function assertReferenceSchematicComponentMetadata(
  netlistBytes: Uint8Array,
  profile: ReferenceControllerProfile,
): readonly ReferenceSelectedComponentMetadata[] {
  return assertReferenceSelectedComponentMetadata(
    parseSchematicNetlist(netlistBytes).components,
    profile,
    "KiCad schematic netlist",
  );
}

export function assertReferenceBomComponentMetadata(
  bomBytes: Uint8Array,
  profile: ReferenceControllerProfile,
): readonly ReferenceSelectedComponentMetadata[] {
  return parseBom(bomBytes, profile).selectedComponents;
}

function assertReferenceSelectedComponentMetadata(
  observed: readonly NativeComponentMetadata[],
  profile: ReferenceControllerProfile,
  source: string,
): readonly ReferenceSelectedComponentMetadata[] {
  const expectedPartNumbers = profile.components.map((component) => component.partNumber);
  if (sortedUnique(expectedPartNumbers).length !== expectedPartNumbers.length) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_PROFILE_UNSUPPORTED",
      "TOOLCHAIN_UNSUPPORTED",
      "Reference profile component part numbers must be unique for exact component metadata binding.",
    );
  }

  const selected: ReferenceSelectedComponentMetadata[] = [];
  const mismatches: Readonly<Record<string, unknown>>[] = [];
  for (const expected of profile.components) {
    const matching = observed.filter((component) => component.partNumber === expected.partNumber);
    const expectedReferences =
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators[expected.key];
    if (expectedReferences.length !== expected.quantity) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_PROFILE_UNSUPPORTED",
        "TOOLCHAIN_UNSUPPORTED",
        "Reference profile component quantity disagrees with the native designator contract.",
        {
          componentKey: expected.key,
          profileQuantity: expected.quantity,
          nativeReferenceCount: expectedReferences.length,
        },
      );
    }
    assertReferenceSetAgreement({
      observed: matching.map((component) => component.reference),
      expected: expectedReferences,
      relationship: "exact",
      source: `${source} ${expected.key}`,
      expectedSource: "the reviewed Rev-A component-designator contract",
      failureCode: "REFERENCE_COMPONENT_METADATA_FAILED",
      details: { componentKey: expected.key, partNumber: expected.partNumber },
    });
    if (matching.length !== expected.quantity) {
      mismatches.push({
        partNumber: expected.partNumber,
        kind: "quantity",
        expected: expected.quantity,
        observed: matching.length,
      });
    }
    for (const component of matching) {
      if (component.value !== expected.partNumber || component.footprint !== expected.footprint) {
        mismatches.push({
          reference: component.reference,
          partNumber: expected.partNumber,
          kind: "identity",
          expectedValue: expected.partNumber,
          observedValue: component.value,
          expectedFootprint: expected.footprint,
          observedFootprint: component.footprint,
        });
      }
      selected.push({
        reference: component.reference,
        partNumber: expected.partNumber,
        value: component.value ?? "",
        footprint: component.footprint ?? "",
      });
    }
  }
  if (mismatches.length > 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "GATE_FAILED",
      `${source} selected-component values, MPNs, footprints, or quantities differ from the bound profile.`,
      { source, mismatches },
    );
  }
  return selected.sort((left, right) => left.reference.localeCompare(right.reference, "en-US"));
}

function parseBoardStatistics(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_OUTPUT_MISSING",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad board statistics are not valid JSON.",
      {},
      false,
      { cause: error },
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.board) || !isRecord(parsed.components)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_OUTPUT_MISSING",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad board statistics have an unsupported structure.",
    );
  }
  const dimensions = [parsed.board.width, parsed.board.height, parsed.board.area];
  if (
    parsed.board.has_outline !== true ||
    dimensions.some((value) => typeof value !== "string" || !(Number.parseFloat(value) > 0))
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_NATIVE_FINDINGS",
      "GATE_FAILED",
      "KiCad native geometry does not contain a positive closed board outline.",
    );
  }
  return parsed;
}

function boardCopperLayerCount(boardBytes: Uint8Array): number {
  const source = Buffer.from(boardBytes).toString("utf8");
  const layerSectionStart = source.indexOf("\n\t(layers");
  const setupStart = source.indexOf("\n\t(setup", layerSectionStart);
  const layerSection =
    layerSectionStart >= 0 && setupStart > layerSectionStart
      ? source.slice(layerSectionStart, setupStart)
      : "";
  return [...layerSection.matchAll(/\(\d+\s+"(?:F|B|In\d+)\.Cu"\s+/gu)].length;
}

function fabricationGeometryFailure(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new ReferenceKicadBackendError(
    "REFERENCE_FABRICATION_GEOMETRY_FAILED",
    "GATE_FAILED",
    message,
    details,
  );
}

function sExpressionNumberField(form: string, field: string, label: string): number {
  const match = new RegExp(`\\(${field}\\s+([-+0-9.eE]+)\\)`, "u").exec(form);
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(value)) {
    fabricationGeometryFailure(`${label} is missing a finite ${field} value.`);
  }
  return value;
}

function sExpressionStringListField(form: string, field: string, label: string): readonly string[] {
  const match = new RegExp(
    `\\(${field}\\s+((?:"(?:\\\\.|[^"\\\\])*"\\s*)+)\\)`,
    "u",
  ).exec(form);
  if (match?.[1] === undefined) {
    fabricationGeometryFailure(`${label} is missing an exact ${field} list.`);
  }
  return [...match[1].matchAll(/"((?:\\.|[^"\\])*)"/gu)].map((entry) =>
    unescapeKicadString(entry[1]!),
  );
}

function exactFabricationNumber(
  actual: unknown,
  expected: number,
  label: string,
): void {
  if (typeof actual !== "number" || !Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
    fabricationGeometryFailure(`${label} must be exactly ${expected} mm.`, { expected, actual });
  }
}

export function assertReferencePcbFabricationGeometry(
  boardBytes: Uint8Array,
  projectBytes: Uint8Array,
  designRulesBytes: Uint8Array,
  profile: ReferenceControllerProfile,
): ReferencePcbFabricationGeometry {
  const source = Buffer.from(boardBytes).toString("utf8");
  if (!source.trimStart().startsWith("(kicad_pcb")) {
    fabricationGeometryFailure("Reference fabrication geometry requires a native KiCad PCB source.");
  }
  const expectedProfileStack = {
    layerCount: 6,
    layers: ["F.Cu", "In1.Signal", "In2.GND", "In3.Power", "In4.Signal", "B.Cu"],
  };
  if (canonicalJson(profile.stackup) !== canonicalJson(expectedProfileStack)) {
    fabricationGeometryFailure("Reference profile does not bind the six-layer 1+4+1 HDI stack.", {
      expected: expectedProfileStack,
      actual: profile.stackup,
    });
  }

  const general = sExpressionForms(source, "general");
  if (general.length !== 1) fabricationGeometryFailure("KiCad PCB must contain one general form.");
  const boardThicknessMm = sExpressionNumberField(general[0]!, "thickness", "KiCad PCB general form");
  exactFabricationNumber(boardThicknessMm, 1.6, "PCB thickness");

  const layerSections = sExpressionForms(source, "layers");
  if (layerSections.length === 0) fabricationGeometryFailure("KiCad PCB layer table is missing.");
  const copperLayers = [...layerSections[0]!.matchAll(
    /^\s*\((\d+)\s+"((?:F|B|In\d+)\.Cu)"\s+(\w+)/gmu,
  )].map((match) => ({ id: Number(match[1]), name: match[2]!, type: match[3]! }));
  if (canonicalJson(copperLayers) !== canonicalJson(REFERENCE_COPPER_LAYER_TABLE)) {
    fabricationGeometryFailure("KiCad PCB copper-layer order, IDs, names, or roles differ from the bound stack.", {
      expected: REFERENCE_COPPER_LAYER_TABLE,
      actual: copperLayers,
    });
  }

  const stackupForms = sExpressionForms(source, "stackup");
  if (stackupForms.length !== 1 || !/\(dielectric_constraints\s+yes\)/u.test(stackupForms[0]!)) {
    fabricationGeometryFailure("KiCad PCB must contain one constrained physical stackup.");
  }
  const stackup = sExpressionForms(stackupForms[0]!, "layer").flatMap((form) => {
    const name = /^\(layer\s+"((?:\\.|[^"\\])+)"/u.exec(form)?.[1];
    if (name === undefined || (!name.endsWith(".Cu") && !name.startsWith("dielectric "))) return [];
    const row: Record<string, unknown> = {
      name: unescapeKicadString(name),
      type: netlistStringField(form, "type"),
      thickness: sExpressionNumberField(form, "thickness", `Stackup ${name}`),
    };
    const material = netlistStringField(form, "material");
    if (material !== null) row.material = material;
    const epsilon = /\(epsilon_r\s+[-+0-9.eE]+\)/u.test(form)
      ? sExpressionNumberField(form, "epsilon_r", `Stackup ${name}`)
      : null;
    if (epsilon !== null) row.epsilonR = epsilon;
    const loss = /\(loss_tangent\s+[-+0-9.eE]+\)/u.test(form)
      ? sExpressionNumberField(form, "loss_tangent", `Stackup ${name}`)
      : null;
    if (loss !== null) row.lossTangent = loss;
    return [row];
  });
  if (canonicalJson(stackup) !== canonicalJson(REFERENCE_STACKUP)) {
    fabricationGeometryFailure("KiCad PCB physical stackup differs from the bound 1.6 mm HDI stack.", {
      expected: REFERENCE_STACKUP,
      actual: stackup,
    });
  }

  let project: unknown;
  try {
    project = JSON.parse(Buffer.from(projectBytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_FABRICATION_GEOMETRY_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad project rules are not valid JSON.",
      {},
      false,
      { cause: error },
    );
  }
  const projectBoard = isRecord(project) && isRecord(project.board) ? project.board : undefined;
  const designSettings = projectBoard !== undefined && isRecord(projectBoard.design_settings)
    ? projectBoard.design_settings
    : undefined;
  const rules = designSettings !== undefined && isRecord(designSettings.rules)
    ? designSettings.rules
    : undefined;
  if (rules === undefined) fabricationGeometryFailure("KiCad project design-rule object is missing.");
  for (const [key, expected] of Object.entries({
    min_clearance: 0.18,
    min_copper_edge_clearance: 0.25,
    min_hole_clearance: 0.25,
    min_microvia_diameter: 0.26,
    min_microvia_drill: 0.1,
    min_track_width: 0.2,
    min_via_annular_width: 0.08,
    min_via_diameter: 0.45,
  })) {
    exactFabricationNumber(rules[key], expected, `KiCad project rule ${key}`);
  }
  const designRules = Buffer.from(designRulesBytes).toString("utf8");
  for (const [label, pattern] of [
    ["clearance", /\(constraint\s+clearance\s+\(min\s+0\.18mm\)\)/u],
    ["track width", /\(constraint\s+track_width\s+\(min\s+0\.20mm\)\)/u],
    ["HDI via diameter", /\(constraint\s+via_diameter\s+\(min\s+0\.26mm\)\)/u],
    ["edge clearance", /\(constraint\s+edge_clearance\s+\(min\s+0\.25mm\)\)/u],
  ] as const) {
    if (!pattern.test(designRules)) {
      fabricationGeometryFailure(`KiCad custom design rules omit the exact ${label} constraint.`);
    }
  }

  const signalTrackCounts: Record<string, number> = Object.fromEntries(
    REFERENCE_SIGNAL_LAYERS.map((layer) => [layer, 0]),
  );
  for (const segment of sExpressionForms(source, "segment")) {
    const layer = netlistStringField(segment, "layer");
    if (layer === null || !REFERENCE_SIGNAL_LAYERS.includes(layer as (typeof REFERENCE_SIGNAL_LAYERS)[number])) {
      fabricationGeometryFailure("Signal segment occupies a plane or unsupported copper layer.", {
        layer,
        net: netlistStringField(segment, "net"),
      });
    }
    signalTrackCounts[layer] = (signalTrackCounts[layer] ?? 0) + 1;
  }

  const planeZones = sExpressionForms(source, "zone").flatMap((zone) => {
    const layer = netlistStringField(zone, "layer");
    if (layer !== "In2.Cu" && layer !== "In3.Cu") return [];
    return [{ net: netlistStringField(zone, "net"), layer }];
  }).sort((left, right) => left.layer.localeCompare(right.layer, "en-US"));
  const expectedPlaneZones = [
    { net: "GND", layer: "In2.Cu" },
    { net: "+3V3", layer: "In3.Cu" },
  ].sort((left, right) => left.layer.localeCompare(right.layer, "en-US"));
  if (canonicalJson(planeZones) !== canonicalJson(expectedPlaneZones)) {
    fabricationGeometryFailure("Dedicated plane layers do not contain exactly one GND and one +3V3 zone.", {
      expected: expectedPlaneZones,
      actual: planeZones,
    });
  }

  const microviaNetCounts: Record<string, number> = {};
  const microviaLocations = new Set<string>();
  let microviaCount = 0;
  let throughViaCount = 0;
  for (const via of sExpressionForms(source, "via")) {
    const diameter = sExpressionNumberField(via, "size", "KiCad via");
    const drill = sExpressionNumberField(via, "drill", "KiCad via");
    const annular = (diameter - drill) / 2;
    const layers = sExpressionStringListField(via, "layers", "KiCad via");
    const net = netlistStringField(via, "net");
    if (/^\(via\s+micro(?:\s|\))/u.test(via)) {
      microviaCount += 1;
      const at = /^\(via\s+micro[\s\S]*?\(at\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\)/u.exec(via);
      const location = at === null ? "" : `${at[1]},${at[2]}`;
      if (
        Math.abs(diameter - 0.26) > 1e-9 ||
        Math.abs(drill - 0.1) > 1e-9 ||
        annular + 1e-9 < 0.08 ||
        canonicalJson(layers) !== canonicalJson(["F.Cu", "In1.Cu"]) ||
        net === null ||
        !(net in REFERENCE_MICROVIA_NET_COUNTS) ||
        location.length === 0 ||
        microviaLocations.has(location)
      ) {
        fabricationGeometryFailure("Microvia geometry, layer span, net, or stacking differs from the bound HDI design.", {
          diameter,
          drill,
          annular,
          layers,
          net,
          location,
        });
      }
      microviaLocations.add(location);
      microviaNetCounts[net] = (microviaNetCounts[net] ?? 0) + 1;
    } else {
      throughViaCount += 1;
      if (
        diameter + 1e-9 < 0.45 ||
        drill + 1e-9 < 0.2 ||
        annular + 1e-9 < 0.08 ||
        canonicalJson(layers) !== canonicalJson(["F.Cu", "B.Cu"])
      ) {
        fabricationGeometryFailure("Ordinary via geometry or layer span is outside the bound through-via envelope.", {
          diameter,
          drill,
          annular,
          layers,
          net,
        });
      }
    }
  }
  if (
    microviaCount !== 11 ||
    canonicalJson(Object.fromEntries(Object.entries(microviaNetCounts).sort())) !==
      canonicalJson(Object.fromEntries(Object.entries(REFERENCE_MICROVIA_NET_COUNTS).sort()))
  ) {
    fabricationGeometryFailure("Microvia count or per-net allocation differs from the bound HDI topology.", {
      expectedCount: 11,
      actualCount: microviaCount,
      expectedNetCounts: REFERENCE_MICROVIA_NET_COUNTS,
      actualNetCounts: microviaNetCounts,
    });
  }

  return {
    schemaVersion: REFERENCE_PCB_FABRICATION_GEOMETRY_SCHEMA,
    boardThicknessMm,
    copperLayers: REFERENCE_COPPER_LAYER_TABLE,
    signalTrackCounts,
    planes: {
      ground: { net: "GND", layer: "In2.Cu" },
      power: { net: "+3V3", layer: "In3.Cu" },
    },
    vias: {
      throughViaCount,
      microviaCount,
      microviaNetCounts: Object.fromEntries(Object.entries(microviaNetCounts).sort()),
      diameterMm: 0.26,
      drillMm: 0.1,
      minimumAnnularWidthMm: 0.08,
      layerPair: ["F.Cu", "In1.Cu"],
    },
  };
}

function firmwareParityFromNetlist(
  nodes: readonly KicadNetlistNode[],
  netlistBytes: Uint8Array,
  profile: KicadBackendRequest["profile"],
  sourceRevisionDigest: string,
): ReferenceFirmwareParityPayload {
  const model = firmwareParityMappingModel(profile);
  const derived = deriveFirmwareParityNodes(nodes, profile);
  if (
    model.missingSignalMappings.length > 0 ||
    model.resourceConflicts.length > 0 ||
    derived.findings.length > 0 ||
    derived.nodes.length !== model.pins.length ||
    derived.pins.length !== model.pins.length
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_CONNECTIVITY_FAILED",
      "GATE_FAILED",
      "Captured KiCad netlist does not provide full, conflict-free firmware pin coverage.",
      {
        expectedPinCount: model.pins.length,
        observedPinCount: derived.nodes.length,
        missingSignalMappings: model.missingSignalMappings,
        resourceConflicts: model.resourceConflicts,
        findings: derived.findings,
      },
    );
  }
  const nativeNetlistIdentity = contentIdentity(netlistBytes);
  return {
    schemaVersion: FIRMWARE_PARITY_NATIVE_SOURCE_SCHEMA,
    nativeNodeLevel: true,
    sourceRevisionDigest,
    profileId: profile.profileId,
    boardRevision: profile.boardRevision,
    profileIdentity: canonicalIdentity(
      profile,
      REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
    ),
    electricalEnvelope: electricalEnvelope(profile),
    templateInstantiationMode: REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
    derivation: {
      method: "kicad-netlist-nodes-plus-pinned-mcu-capabilities",
      nativeNetlistIdentity,
      mappingModelIdentity: firmwareParityMappingModelIdentity(profile),
    },
    nativeNodes: derived.nodes,
    pins: derived.pins,
    resources: model.resources,
    protocols: model.protocols,
  };
}

export function deriveReferenceFirmwareParityFromNetlist(
  netlistBytes: Uint8Array,
  profile: KicadBackendRequest["profile"],
  sourceRevisionDigest: string,
): ReferenceFirmwareParityPayload {
  if (!/^[0-9a-f]{64}$/u.test(sourceRevisionDigest)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_REQUEST_INVALID",
      "INVALID_ARGUMENT",
      "Firmware parity derivation requires a lowercase SHA-256 source revision digest.",
    );
  }
  const parsed = parseSchematicNetlist(netlistBytes);
  return firmwareParityFromNetlist(parsed.nodes, netlistBytes, profile, sourceRevisionDigest);
}

async function connectivitySummary(
  inspection: KicadNativeInspectionResult,
  boardBytes: Uint8Array,
  request: KicadBackendRequest,
): Promise<ConnectivitySummary> {
  const [netlistBytes, boardNetlistBytes] = await Promise.all([
    regularFileBytes(inspection.schematicNetlist.path, "KiCad schematic netlist"),
    regularFileBytes(inspection.boardNetlist.path, "KiCad IPC-D-356 board netlist"),
  ]);
  const schematic = parseSchematicNetlist(netlistBytes);
  const pcbComponents = parsePcbComponents(boardBytes);
  const positionReferenceSource = pcbPositionReferenceSource(pcbComponents);
  const pcbReferences = positionReferenceSource.pcbReferences;
  const selectedSchematicComponents = assertReferenceSelectedComponentMetadata(
    schematic.components,
    request.profile,
    "KiCad schematic netlist",
  );
  const selectedPcbComponents = assertReferenceSelectedComponentMetadata(
    pcbComponents,
    request.profile,
    "KiCad PCB",
  );
  assertReferenceSetAgreement({
    observed: pcbReferences,
    expected: schematic.references,
    relationship: "exact",
    source: "KiCad PCB footprint",
    expectedSource: "the schematic component set",
    failureCode: "REFERENCE_CONNECTIVITY_FAILED",
  });
  if (canonicalJson(selectedSchematicComponents) !== canonicalJson(selectedPcbComponents)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_COMPONENT_METADATA_FAILED",
      "GATE_FAILED",
      "KiCad schematic and PCB selected-component metadata differ by reference.",
      {
        schematic: selectedSchematicComponents,
        pcb: selectedPcbComponents,
      },
    );
  }
  const boardNetlist = boardNetlistBytes.toString("utf8");
  const records = boardNetlist.split(/\r?\n/gu).filter((line) => /^(?:317|327)/u.test(line));
  if (!boardNetlist.startsWith("P  CODE 00") || !/\r?\n999\s*$/u.test(boardNetlist) || records.length === 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_CONNECTIVITY_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad IPC-D-356 board netlist is missing its required header, records, or terminator.",
    );
  }
  return {
    schematicReferences: schematic.references,
    pcbReferences,
    netNames: schematic.netNames,
    schematicComponentCount: schematic.references.length,
    pcbFootprintCount: pcbReferences.length,
    boardNetlistRecordCount: records.length,
    schematicNetlistIdentity: contentIdentity(netlistBytes),
    selectedComponents: {
      schematic: selectedSchematicComponents,
      pcb: selectedPcbComponents,
    },
    positionReferenceSource,
    firmwareParity: firmwareParityFromNetlist(
      schematic.nodes,
      netlistBytes,
      request.profile,
      request.expectedSourceRevisionDigest,
    ),
  };
}

function parseCsvRows(
  text: string,
  source = "KiCad BOM CSV",
  failureCode: ReferenceKicadFailureCode = "REFERENCE_BOM_PARITY_FAILED",
): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterClosingQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        afterClosingQuote = true;
      } else {
        field += character;
      }
    } else if (afterClosingQuote) {
      if (character === ",") {
        row.push(field);
        field = "";
        afterClosingQuote = false;
      } else if (character === "\n") {
        row.push(field);
        if (row.some((value) => value.length > 0)) rows.push(row);
        row = [];
        field = "";
        afterClosingQuote = false;
      } else if (character !== "\r" || text[index + 1] !== "\n") {
        throw new ReferenceKicadBackendError(
          failureCode,
          "TOOL_RESULT_INCONCLUSIVE",
          `${source} contains trailing data after a closing quote.`,
        );
      }
    } else if (character === '"') {
      if (field.length !== 0) {
        throw new ReferenceKicadBackendError(
          failureCode,
          "TOOL_RESULT_INCONCLUSIVE",
          `${source} contains a quote inside an unquoted field.`,
        );
      }
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new ReferenceKicadBackendError(
      failureCode,
      "TOOL_RESULT_INCONCLUSIVE",
      `${source} ends inside a quoted field.`,
    );
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows;
}

function expandReferenceToken(token: string): readonly string[] {
  const range = /^(?<prefix>[A-Za-z]+)(?<start>\d+)-(?:(?<endPrefix>[A-Za-z]+))?(?<end>\d+)$/u.exec(
    token.trim(),
  );
  if (range?.groups !== undefined) {
    const prefix = range.groups.prefix!;
    const endPrefix = range.groups.endPrefix ?? prefix;
    const start = Number(range.groups.start);
    const end = Number(range.groups.end);
    if (prefix !== endPrefix || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 10_000) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_BOM_PARITY_FAILED",
        "TOOL_RESULT_INCONCLUSIVE",
        `KiCad BOM contains an unsupported reference range '${token}'.`,
      );
    }
    return Array.from({ length: end - start + 1 }, (_, index) => `${prefix}${start + index}`);
  }
  if (!/^[A-Za-z]+\d+$/u.test(token.trim())) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_BOM_PARITY_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      `KiCad BOM contains an invalid reference '${token}'.`,
    );
  }
  return [token.trim()];
}

function parseBom(bytes: Uint8Array, profile: ReferenceControllerProfile): BomSummary {
  const rows = parseCsvRows(Buffer.from(bytes).toString("utf8"));
  const header = rows[0];
  if (header === undefined) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_BOM_PARITY_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad BOM is empty.",
    );
  }
  const referenceIndex = header.indexOf("Reference");
  const valueIndex = header.indexOf("Value");
  const quantityIndices = [header.indexOf("Quantity"), header.indexOf("QUANTITY")].filter(
    (index) => index >= 0,
  );
  const quantityIndex = quantityIndices[0] ?? -1;
  const footprintIndex = header.indexOf("Footprint");
  const partNumberIndex = header.indexOf("MPN");
  const dnpIndices = header
    .map((value, index) => value === "DNP" ? index : -1)
    .filter((index) => index >= 0);
  const dnpIndex = dnpIndices[0] ?? -1;
  if (
    referenceIndex < 0 ||
    valueIndex < 0 ||
    quantityIndices.length !== 1 ||
    quantityIndex < 0 ||
    footprintIndex < 0 ||
    partNumberIndex < 0 ||
    dnpIndices.length !== 1 ||
    dnpIndex < 0
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_BOM_PARITY_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad BOM is missing Reference, Value, Quantity, Footprint, MPN, or DNP columns.",
    );
  }
  const references: string[] = [];
  const dnpReferences: string[] = [];
  const components: NativeComponentMetadata[] = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const referenceCell = row[referenceIndex] ?? "";
    const value = row[valueIndex] ?? "";
    const footprint = row[footprintIndex] ?? "";
    const partNumber = row[partNumberIndex] ?? "";
    const dnp = row[dnpIndex] ?? "";
    const expanded = referenceCell.split(",").flatMap(expandReferenceToken);
    const quantity = Number(row[quantityIndex]);
    if (
      footprint.length === 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity !== expanded.length ||
      (dnp !== "" && dnp !== "DNP")
    ) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_BOM_PARITY_FAILED",
        "GATE_FAILED",
        `KiCad BOM row ${index + 2} has a missing footprint, inconsistent quantity, or invalid DNP value.`,
        { referenceCell, quantity, expandedCount: expanded.length, dnp },
      );
    }
    references.push(...expanded);
    if (dnp === "DNP") dnpReferences.push(...expanded);
    for (const reference of expanded) {
      components.push({
        reference,
        value,
        footprint,
        partNumber: partNumber.length === 0 ? null : partNumber,
      });
    }
  }
  if (references.length === 0 || sortedUnique(references).length !== references.length) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_BOM_PARITY_FAILED",
      "GATE_FAILED",
      "KiCad BOM has no unique structural reference set.",
    );
  }
  return {
    references: sortedUnique(references),
    dnpReferences: sortedUnique(dnpReferences),
    rowCount: rows.length - 1,
    selectedComponents: assertReferenceSelectedComponentMetadata(components, profile, "KiCad BOM"),
  };
}

function parsePositionSummary(bytes: Uint8Array): PositionSummary {
  const rows = parseCsvRows(
    Buffer.from(bytes).toString("utf8"),
    "KiCad position CSV",
    "REFERENCE_POSITION_PARITY_FAILED",
  );
  const header = rows[0];
  if (header === undefined) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_POSITION_PARITY_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad position CSV is empty.",
    );
  }
  const referenceIndices = header
    .map((value, index) => value === "Ref" ? index : -1)
    .filter((index) => index >= 0);
  const sideIndices = header
    .map((value, index) => value === "Side" ? index : -1)
    .filter((index) => index >= 0);
  if (referenceIndices.length !== 1 || sideIndices.length !== 1) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_POSITION_PARITY_FAILED",
      "TOOL_RESULT_INCONCLUSIVE",
      "KiCad position CSV must contain exactly one Ref and one Side column.",
    );
  }
  const referenceIndex = referenceIndices[0]!;
  const sideIndex = sideIndices[0]!;
  const references: string[] = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const reference = row[referenceIndex] ?? "";
    const side = row[sideIndex] ?? "";
    if (row.length !== header.length || !/^[A-Za-z]+\d+$/u.test(reference)) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_POSITION_PARITY_FAILED",
        "TOOL_RESULT_INCONCLUSIVE",
        `KiCad position CSV row ${index + 2} is malformed.`,
        { reference, columnCount: row.length, expectedColumnCount: header.length },
      );
    }
    if (side !== "top" && side !== "bottom") {
      throw new ReferenceKicadBackendError(
        "REFERENCE_POSITION_PARITY_FAILED",
        "TOOL_RESULT_INCONCLUSIVE",
        `KiCad position CSV row ${index + 2} has an unsupported board side.`,
        { reference, side },
      );
    }
    references.push(reference);
  }
  const canonicalReferences = assertReferenceSetAgreement({
    observed: references,
    expected: references,
    relationship: "exact",
    source: "KiCad position CSV",
    expectedSource: "a unique position reference set",
    failureCode: "REFERENCE_POSITION_PARITY_FAILED",
  });
  return { references: canonicalReferences, rowCount: rows.length - 1 };
}

function assertNativeChecks(checks: KicadCheckResult, stage: KicadBackendRequest["stage"]): void {
  if (checks.erc.status !== "clean" || checks.erc.violationCount !== 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_NATIVE_FINDINGS",
      "GATE_FAILED",
      `Fresh KiCad ERC contains ${checks.erc.violationCount} findings.`,
      { stage, findingCount: checks.erc.violationCount },
    );
  }
  if (
    checks.drc.status !== "clean" ||
    checks.drc.violationCount !== 0 ||
    checks.drc.schematicParityCount !== 0
  ) {
    const unconnected = Array.isArray(checks.drc.report.unconnected_items)
      ? checks.drc.report.unconnected_items.length
      : undefined;
    throw new ReferenceKicadBackendError(
      typeof unconnected === "number" && unconnected > 0
        ? "REFERENCE_ROUTING_INCOMPLETE"
        : "REFERENCE_NATIVE_FINDINGS",
      "GATE_FAILED",
      `Fresh KiCad DRC/parity contains ${checks.drc.violationCount} findings.`,
      {
        stage,
        findingCount: checks.drc.violationCount,
        schematicParityCount: checks.drc.schematicParityCount,
        unconnectedCount: unconnected,
      },
    );
  }
}

function assertExecutableIdentity(
  manifest: Readonly<Record<string, unknown>>,
  identity: KicadExecutableIdentity,
): void {
  if (identity.version !== REFERENCE_KICAD_VERSION) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_TOOLCHAIN_MISMATCH",
      "TOOLCHAIN_UNSUPPORTED",
      `Reviewed-template reference requires KiCad ${REFERENCE_KICAD_VERSION}, received ${identity.version}.`,
      { executablePath: identity.path, executableSha256: identity.sha256 },
    );
  }
  const executable = isRecord(manifest.executable) ? manifest.executable : undefined;
  if (
    executable === undefined ||
    executable.version !== identity.version ||
    executable.commit !== identity.commit ||
    executable.sha256 !== identity.sha256 ||
    executable.sizeBytes !== identity.sizeBytes ||
    executable.capabilityHelpSha256 !== identity.capabilityHelpSha256 ||
    executable.identityMatchesAdapter !== true
  ) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_TOOLCHAIN_MISMATCH",
      "TOOLCHAIN_UNSUPPORTED",
      "Current kicad-cli identity does not match canonical reference validation.",
      {
        current: {
          path: identity.path,
          version: identity.version,
          sha256: identity.sha256,
          capabilityHelpSha256: identity.capabilityHelpSha256,
        },
      },
    );
  }
}

function artifactFromBytes(
  role: KicadArtifactRole,
  logicalName: string,
  mediaType: string,
  bytes: Uint8Array,
): KicadGeneratedArtifact {
  if (bytes.byteLength === 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_OUTPUT_MISSING",
      "TOOL_RESULT_INCONCLUSIVE",
      `Required output ${logicalName} is empty.`,
    );
  }
  return { role, logicalName, mediaType, content: Buffer.from(bytes) };
}

function mediaTypeFor(fileName: string): string {
  const extension = path.extname(fileName).toLocaleLowerCase("en-US");
  switch (extension) {
    case ".json":
    case ".gbrjob":
      return JSON_MEDIA_TYPE;
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".gbr":
      return "application/vnd.gerber";
    case ".drl":
      return "application/x-excellon";
    case ".kicad_pro":
    case ".kicad_sch":
    case ".kicad_pcb":
      return TEXT_MEDIA_TYPE;
    default:
      return TEXT_MEDIA_TYPE;
  }
}

function outputBinding(logicalName: string, content: Uint8Array): Readonly<Record<string, unknown>> {
  return { logicalName, identity: contentIdentity(content) };
}

function templateReuseProvenance(
  requestBinding: ReferenceKicadRequestBinding,
): Readonly<Record<string, unknown>> {
  return {
    operation: REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
    nativeDesignOrigin: "exact-validated-rev-a-reviewed-template",
    templateInstantiationIdentity: requestBinding.templateInstantiation.identity,
    requestedProfileIdentity:
      requestBinding.templateInstantiation.requestedProfile.profileIdentity,
    requestedElectricalEnvelope:
      requestBinding.templateInstantiation.requestedProfile.electricalEnvelope,
    structuralRelationship: "identical",
    electricalEnvelopeRelationship: "requested-subset-of-template",
    topologyGenerationPerformed: false,
    nativeDesignMutationPerformed: false,
    artifactSemantics: "validated-template-copy-not-newly-generated-pcb",
    statement:
      "The exact validated Rev-A native design was copied, checked, and exported for a subset operating envelope; no new schematic or PCB topology was generated for this request.",
  };
}

function sourceReportBindings(evidence: ExecutionEvidence): readonly KicadReportBinding[] {
  return evidence.sourceBindings.map((binding) => ({
    logicalName: binding.path,
    identity: {
      algorithm: "sha256",
      digest: binding.sha256,
      size: binding.sizeBytes,
    },
  }));
}

function reportBinding(report: KicadBackendReport): KicadReportInputBinding {
  return {
    kind: "native_report",
    logicalName: report.logicalName,
    identity: contentIdentity(report.content),
  };
}

function artifactReportBinding(
  logicalName: string,
  content: Uint8Array,
): KicadReportInputBinding {
  return { kind: "artifact", logicalName, identity: contentIdentity(content) };
}

async function nativeReport(
  kind: "erc" | "drc" | "schematic_netlist" | "board_statistics" | "board_netlist",
  logicalName: string,
  filePath: string,
  invocation: KicadCliInvocationEvidence,
  request: KicadBackendRequest,
  evidence: ExecutionEvidence,
): Promise<KicadNativeReport> {
  const content = await regularFileBytes(filePath, `Native KiCad ${kind} report`);
  const tool = toolIdentity(invocation.executable);
  if (canonicalJson(tool) !== canonicalJson(toolIdentity(evidence.adapter.identity))) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_TOOLCHAIN_MISMATCH",
      "TOOLCHAIN_UNSUPPORTED",
      `Native ${kind} report invocation does not match the active KiCad CLI identity.`,
    );
  }
  return {
    kind,
    logicalName,
    mediaType: mediaTypeFor(filePath),
    content,
    sourceRevisionDigest: request.expectedSourceRevisionDigest,
    validationStatus: "pass",
    evidenceClass: "kicad_native",
    authority: {
      kind: "kicad_cli_output",
      tool,
      command: invocation.args,
      outputIdentity: contentIdentity(content),
      sourceBindings: sourceReportBindings(evidence),
    },
  };
}

function derivedReport(
  kind: KicadEvledaCheckReportKind,
  logicalName: string,
  request: KicadBackendRequest,
  evidence: ExecutionEvidence,
  nativeInputs: readonly KicadNativeReport[],
  artifactInputs: readonly KicadReportInputBinding[],
  payload: Readonly<Record<string, unknown>>,
  validationStatus: "pass" | "fail" = "pass",
): KicadEvledaCheckReport {
  if (nativeInputs.length === 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_OUTPUT_MISSING",
      "TOOL_RESULT_INCONCLUSIVE",
      `Derived ${kind} report has no exact native report authority.`,
    );
  }
  const tool = REFERENCE_KICAD_ANALYZER_TOOLS[kind];
  const analyzerId = tool.capabilityProfile;
  const sourceBindings = sourceReportBindings(evidence).map(
    (binding): KicadReportInputBinding => ({ ...binding, kind: "source" }),
  );
  const inputBindings = [
    ...nativeInputs.map(reportBinding),
    ...artifactInputs,
    ...sourceBindings,
  ];
  const authority = {
    kind: "evleda_analyzer" as const,
    analyzerId,
    tool,
    inputBindings,
  };
  const requestBinding = referenceKicadRequestBinding(request);
  const document = {
    schemaVersion: REFERENCE_KICAD_REPORT_SCHEMA,
    kind,
    validationStatus,
    classification: "candidate-validation",
    lifecycle: "candidate",
    releaseAuthorized: false,
    sourceRevisionDigest: request.expectedSourceRevisionDigest,
    requestBinding,
    authority,
    provenance: templateReuseProvenance(requestBinding),
    canonicalValidation: {
      manifestIdentity: evidence.canonical.validationIdentity,
      validationRoot: evidence.canonical.validationRoot,
      regeneration: evidence.canonical.regeneration,
    },
    unresolvedAssumptions: evidence.canonical.qualificationOnlyAssumptions,
    executable: evidence.adapter.identity,
    sourceBindings: evidence.sourceBindings,
    payload,
  };
  return {
    kind,
    logicalName,
    mediaType: JSON_MEDIA_TYPE,
    content: Buffer.from(canonicalJson(document), "utf8"),
    sourceRevisionDigest: request.expectedSourceRevisionDigest,
    validationStatus,
    evidenceClass: "evleda_check",
    authority,
  };
}

function invocationFor(
  invocations: readonly KicadCliInvocationEvidence[],
  prefix: readonly string[],
): KicadCliInvocationEvidence {
  const invocation = invocations.find((candidate) =>
    prefix.every((part, index) => candidate.args[index] === part),
  );
  if (invocation === undefined) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_OUTPUT_MISSING",
      "TOOL_RESULT_INCONCLUSIVE",
      `Missing successful KiCad invocation for '${prefix.join(" ")}'.`,
    );
  }
  return invocation;
}

async function readExportArtifact(artifact: KicadCandidateArtifact): Promise<Buffer> {
  const bytes = await regularFileBytes(artifact.path, `KiCad export ${artifact.relativePath}`);
  const identity = contentIdentity(bytes);
  if (identity.digest !== artifact.sha256 || identity.size !== artifact.sizeBytes) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_OUTPUT_MISSING",
      "ARTIFACT_INTEGRITY_ERROR",
      `KiCad export changed before capture: ${artifact.relativePath}.`,
    );
  }
  return bytes;
}

function isEphemeralKicadProjectFile(relativePath: string): boolean {
  return relativePath.endsWith(".kicad_prl") || /(?:^|\/)~[^/]+\.lck$/u.test(relativePath);
}

async function assertWorkingCopyMatchesCanonical(
  projectRoot: string,
  expectedBindings: readonly FileBinding[],
): Promise<readonly FileBinding[]> {
  const expected = new Map(expectedBindings.map((binding) => [binding.path, binding] as const));
  const results: FileBinding[] = [];
  const pending = [projectRoot];
  let entriesSeen = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > 10_000) {
        throw staleValidation("Working-copy source inventory exceeded its entry limit.");
      }
      const entryPath = path.join(directory, entry.name);
      const relativePath = normalizedLogicalPath(path.relative(projectRoot, entryPath));
      if (entry.isSymbolicLink()) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_SOURCE_UNAVAILABLE",
          "TOOLCHAIN_UNAVAILABLE",
          `Working copy contains forbidden symbolic link ${relativePath}.`,
        );
      }
      if (entry.isDirectory()) {
        const canonicalDirectory = await realpath(entryPath);
        assertPathWithin(projectRoot, canonicalDirectory, "Working copy directory", false);
        pending.push(canonicalDirectory);
      } else if (entry.isFile()) {
        if (isEphemeralKicadProjectFile(relativePath)) continue;
        const expectedBinding = expected.get(relativePath);
        if (expectedBinding === undefined) {
          throw new ReferenceKicadBackendError(
            "REFERENCE_SOURCE_MUTATED",
            "ARTIFACT_INTEGRITY_ERROR",
            `Working copy contains an unbound source file: ${relativePath}.`,
            { path: relativePath },
          );
        }
        const metadata = await lstat(entryPath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
          throw staleValidation(`Working-copy source is not a single-link ordinary file: ${relativePath}.`);
        }
        const actual = await bindingFor(entryPath, relativePath);
        if (
          actual.sha256 !== expectedBinding.sha256 ||
          actual.sizeBytes !== expectedBinding.sizeBytes
        ) {
          throw new ReferenceKicadBackendError(
            "REFERENCE_SOURCE_MUTATED",
            "ARTIFACT_INTEGRITY_ERROR",
            `Working-copy source differs from canonical binding: ${relativePath}.`,
            { expected: expectedBinding, actual },
          );
        }
        results.push(actual);
      } else {
        throw staleValidation(`Working copy contains a special filesystem entry: ${relativePath}.`);
      }
    }
  }
  results.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  const missing = expectedBindings
    .map((binding) => binding.path)
    .filter((relativePath) => !results.some((binding) => binding.path === relativePath));
  if (missing.length > 0) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_MUTATED",
      "ARTIFACT_INTEGRITY_ERROR",
      "Working copy is missing canonical source files.",
      { missingPaths: missing },
    );
  }
  return results;
}

async function prepareWorkRoot(rawWorkRoot: string, referenceRoot: string): Promise<string> {
  if (!path.isAbsolute(rawWorkRoot)) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_REQUEST_INVALID",
      "INVALID_ARGUMENT",
      "Reference KiCad work root must be explicitly configured as an absolute path.",
    );
  }
  const requestedMetadata = await lstat(path.resolve(rawWorkRoot));
  if (requestedMetadata.isSymbolicLink()) {
    throw new ReferenceKicadBackendError(
      "REFERENCE_REQUEST_INVALID",
      "INVALID_ARGUMENT",
      "Reference KiCad work root must not be a symbolic link.",
    );
  }
  const workRoot = await resolveExistingDirectory(rawWorkRoot, "Reference KiCad work root");
  assertDisjointDirectories(referenceRoot, workRoot, "Reference design root", "KiCad work root");
  return workRoot;
}

function toolIdentity(identity: KicadExecutableIdentity): KicadNativeToolIdentity {
  return {
    name: "KiCad CLI",
    version: identity.version,
    adapter: "kicad_cli",
    executablePath: identity.path,
    executableDigest: identity.sha256,
    capabilityProfile: `${REFERENCE_KICAD_BACKEND_ID}:${identity.capabilityHelpSha256}`,
  };
}

function mapUnexpectedError(error: unknown): ReferenceKicadBackendError {
  if (error instanceof ReferenceKicadBackendError) return error;
  if (error instanceof ReferenceControllerNativeContractError) {
    const integrityFailure = new Set([
      "REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED",
      "REFERENCE_NATIVE_CONTRACT_SOURCE_NOT_ORDINARY",
      "REFERENCE_NATIVE_CONTRACT_SOURCE_UNAVAILABLE",
      "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH",
      "REFERENCE_NATIVE_CONTRACT_IDENTITY_MISMATCH",
      "REFERENCE_NATIVE_CONTRACT_NON_CANONICAL_JSON",
      "REFERENCE_NATIVE_CONTRACT_INVALID_AUTHORITY_SNAPSHOT",
      "REFERENCE_NATIVE_CONTRACT_TOO_LARGE",
    ]).has(error.code);
    return new ReferenceKicadBackendError(
      integrityFailure ? "REFERENCE_SOURCE_MUTATED" : "REFERENCE_VALIDATION_STALE",
      integrityFailure ? "ARTIFACT_INTEGRITY_ERROR" : "EVIDENCE_STALE",
      "The module-owned Rev-A native-contract authority is unavailable, invalid, or changed.",
      { nativeContractErrorCode: error.code },
      false,
      { cause: error },
    );
  }
  if (error instanceof KicadSourceMutationError) {
    return new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_MUTATED",
      "ARTIFACT_INTEGRITY_ERROR",
      "kicad-cli changed protected source bytes in the isolated working copy.",
      { changedPaths: error.changedPaths },
      false,
      { cause: error },
    );
  }
  if (error instanceof KicadCliInvocationError) {
    return new ReferenceKicadBackendError(
      "REFERENCE_BACKEND_INCONCLUSIVE",
      "TOOL_RESULT_INCONCLUSIVE",
      "A required kicad-cli invocation failed.",
      { args: error.args, exitCode: error.exitCode },
      true,
      { cause: error },
    );
  }
  if (error instanceof KicadCliError) {
    return new ReferenceKicadBackendError(
      "REFERENCE_TOOLCHAIN_MISMATCH",
      "TOOLCHAIN_UNSUPPORTED",
      error.message,
      {},
      false,
      { cause: error },
    );
  }
  if (error instanceof PathBoundaryError) {
    return new ReferenceKicadBackendError(
      "REFERENCE_SOURCE_UNAVAILABLE",
      "PATH_OUTSIDE_WORKSPACE",
      error.message,
      {},
      false,
      { cause: error },
    );
  }
  const nodeCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (nodeCode === "ENOENT" || nodeCode === "EACCES" || nodeCode === "EPERM") {
    return new ReferenceKicadBackendError(
      "REFERENCE_TOOLCHAIN_UNAVAILABLE",
      "TOOLCHAIN_UNAVAILABLE",
      "A configured Reference KiCad source, work root, or executable is unavailable.",
      { systemErrorCode: nodeCode },
      true,
      { cause: error },
    );
  }
  return new ReferenceKicadBackendError(
    "REFERENCE_BACKEND_INCONCLUSIVE",
    "TOOL_RESULT_INCONCLUSIVE",
    "Reference KiCad backend failed without conclusive typed evidence.",
    {},
    false,
    { cause: error },
  );
}

export class ReferenceKicadBackend implements KicadGenerationBackend {
  public readonly backendId = REFERENCE_KICAD_BACKEND_ID;
  readonly #options: ReferenceKicadBackendOptions;

  public constructor(options: ReferenceKicadBackendOptions) {
    this.#options = { ...options };
  }

  public async execute(request: KicadBackendRequest): Promise<KicadBackendResult> {
    try {
      // Freeze the semantic request at the boundary so a caller cannot change the
      // requested envelope while native validation is running asynchronously.
      return await this.#execute(structuredClone(request));
    } catch (error) {
      throw mapUnexpectedError(error);
    }
  }

  async #execute(request: KicadBackendRequest): Promise<KicadBackendResult> {
    assertRequest(request);
    const canonical = await validateCanonicalReference(
      this.#options.referenceDesignRoot ?? DEFAULT_REFERENCE_ROOT,
    );
    try {
    const workRoot = await prepareWorkRoot(this.#options.workRoot, canonical.referenceRoot);
    let working: WorkingCopy | undefined;
    let result: KicadBackendResult | undefined;
    let primaryError: unknown;
    try {
      working = await createWorkingCopy(canonical, workRoot);
      await assertWorkingCopyMatchesCanonical(working.projectRoot, canonical.sourceBindings);
      const executablePath = configuredKicadCliPath(
        this.#options.executablePath,
        this.#options.environment ?? process.env,
      );
      if (!path.isAbsolute(executablePath)) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_TOOLCHAIN_UNAVAILABLE",
          "INVALID_ARGUMENT",
          "kicad-cli executable path must be absolute.",
        );
      }
      const executable = await resolveExistingFile(executablePath, "kicad-cli executable");
      if (!/^kicad-cli(?:\.exe)?$/iu.test(path.basename(executable))) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_TOOLCHAIN_MISMATCH",
          "TOOLCHAIN_UNSUPPORTED",
          "Reference backend invokes only kicad-cli; KiCad GUI binaries are forbidden.",
          { executablePath: executable },
        );
      }
      const adapter = await KicadCliAdapter.create({
        workspaceRoot: working.runRoot,
        projectRoot: working.projectRoot,
        executablePath: executable,
        ...(this.#options.environment === undefined ? {} : { environment: this.#options.environment }),
        ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
        ...(this.#options.maxOutputBytes === undefined
          ? {}
          : { maxOutputBytes: this.#options.maxOutputBytes }),
        ...(this.#options.maxReportBytes === undefined
          ? {}
          : { maxReportBytes: this.#options.maxReportBytes }),
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
      });
      await assertWorkingCopyMatchesCanonical(working.projectRoot, canonical.sourceBindings);
      assertExecutableIdentity(canonical.validationDocument, adapter.identity);

      const checks = await adapter.runChecks({
        schematicPath: working.schematicPath,
        pcbPath: working.pcbPath,
        outputDirectory: path.join(working.runRoot, "checks"),
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
      });
      await assertWorkingCopyMatchesCanonical(working.projectRoot, canonical.sourceBindings);
      assertNativeChecks(checks, request.stage);
      const inspection = await adapter.inspectNativeDesign({
        schematicPath: working.schematicPath,
        pcbPath: working.pcbPath,
        outputDirectory: path.join(working.runRoot, "inspection"),
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
      });
      await assertWorkingCopyMatchesCanonical(working.projectRoot, canonical.sourceBindings);
      const [boardBytes, projectBytes, designRulesBytes] = await Promise.all([
        regularFileBytes(working.pcbPath, "Isolated KiCad PCB"),
        regularFileBytes(working.projectPath, "Isolated KiCad project"),
        regularFileBytes(
          path.join(working.projectRoot, `${DESIGN_NAME}.kicad_dru`),
          "Isolated KiCad design rules",
        ),
      ]);
      const fabricationGeometry = assertReferencePcbFabricationGeometry(
        boardBytes,
        projectBytes,
        designRulesBytes,
        request.profile,
      );
      const connectivity = await connectivitySummary(inspection, boardBytes, request);
      const statisticsBytes = await regularFileBytes(
        inspection.boardStatistics.path,
        "KiCad board statistics",
      );
      const statistics = parseBoardStatistics(statisticsBytes);
      if (boardCopperLayerCount(boardBytes) !== ROBOTICS_CONTROLLER_V0.stackup.layerCount) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_NATIVE_FINDINGS",
          "GATE_FAILED",
          "PCB copper-layer count differs from the supported reference profile.",
        );
      }
      const statisticComponents = statistics.components;
      const total = isRecord(statisticComponents) && isRecord(statisticComponents.total)
        ? statisticComponents.total.total
        : undefined;
      if (total !== connectivity.pcbFootprintCount) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_CONNECTIVITY_FAILED",
          "GATE_FAILED",
          "KiCad native component statistics disagree with the PCB reference set.",
          { nativeTotal: total, parsedTotal: connectivity.pcbFootprintCount },
        );
      }

      const exported =
        request.stage === "schematic"
          ? undefined
          : await adapter.exportCandidateArtifacts({
              schematicPath: working.schematicPath,
              pcbPath: working.pcbPath,
              outputDirectory: path.join(working.runRoot, "exports"),
              ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
            });
      const sourceBindings = await assertWorkingCopyMatchesCanonical(
        working.projectRoot,
        canonical.sourceBindings,
      );
      const evidence: ExecutionEvidence = {
        adapter,
        canonical,
        working,
        checks,
        inspection,
        ...(exported === undefined ? {} : { exported }),
        connectivity,
        fabricationGeometry,
        sourceBindings,
      };
      result = await this.#stageResult(request, evidence, statistics);
      await assertSnapshotUnchanged(canonical);
    } catch (error) {
      primaryError = error;
      if (working !== undefined) {
        try {
          await assertWorkingCopyMatchesCanonical(working.projectRoot, canonical.sourceBindings);
          await assertSnapshotUnchanged(canonical);
        } catch (integrityError) {
          primaryError = integrityError;
          throw integrityError;
        }
      }
      throw error;
    } finally {
      if (working !== undefined) {
        try {
          const canonicalRunRoot = await realpath(working.runRoot);
          assertPathWithin(workRoot, canonicalRunRoot, "Reference KiCad cleanup target", false);
          const metadata = await lstat(canonicalRunRoot);
          if (
            metadata.isSymbolicLink() ||
            !metadata.isDirectory() ||
            metadata.dev !== working.runDevice ||
            metadata.ino !== working.runInode
          ) {
            throw new Error("cleanup target is not the original run-owned directory instance");
          }
          await rm(canonicalRunRoot, { recursive: true, force: false });
        } catch (cleanupError) {
          throw new ReferenceKicadBackendError(
            "REFERENCE_WORKSPACE_CLEANUP_FAILED",
            "ARTIFACT_INTEGRITY_ERROR",
            "Failed to clean the isolated Reference KiCad working directory.",
            { workingDirectory: working.runRoot, hadPrimaryError: primaryError !== undefined },
            false,
            { cause: cleanupError },
          );
        }
      }
    }
    if (result === undefined) {
      throw new ReferenceKicadBackendError(
        "REFERENCE_BACKEND_INCONCLUSIVE",
        "TOOL_RESULT_INCONCLUSIVE",
        "Reference KiCad backend completed without a result.",
      );
    }
    return result;
    } finally {
      await reverifyReferenceControllerRevANativeAuthority(
        canonical.nativeContractAuthority,
      );
    }
  }

  async #stageResult(
    request: KicadBackendRequest,
    evidence: ExecutionEvidence,
    statistics: Readonly<Record<string, unknown>>,
  ): Promise<KicadBackendResult> {
    const artifacts: KicadGeneratedArtifact[] = [];
    const reports: KicadBackendReport[] = [];
    let positionSummary: PositionSummary | undefined;
    let positionReferencePolicy: PcbPositionReferencePolicy | undefined;
    if (request.stage === "schematic") {
      const [projectBytes, schematicBytes, netlistBytes] = await Promise.all([
        regularFileBytes(evidence.working.projectPath, "Isolated KiCad project"),
        regularFileBytes(evidence.working.schematicPath, "Isolated KiCad schematic"),
        regularFileBytes(evidence.inspection.schematicNetlist.path, "KiCad schematic netlist"),
      ]);
      artifacts.push(
        artifactFromBytes(
          "project",
          `kicad/${DESIGN_NAME}/${DESIGN_NAME}.kicad_pro`,
          mediaTypeFor(evidence.working.projectPath),
          projectBytes,
        ),
        artifactFromBytes(
          "schematic",
          `kicad/${DESIGN_NAME}/${DESIGN_NAME}.kicad_sch`,
          mediaTypeFor(evidence.working.schematicPath),
          schematicBytes,
        ),
      );
      const ercReport = await nativeReport(
        "erc",
        "reports/kicad/schematic/erc.json",
        evidence.checks.erc.reportPath,
        evidence.checks.erc.invocation,
        request,
        evidence,
      );
      const schematicNetlistReport = await nativeReport(
        "schematic_netlist",
        "reports/kicad/schematic/native/schematic-netlist.kicad_net",
        evidence.inspection.schematicNetlist.path,
        invocationFor(evidence.inspection.invocations, ["sch", "export", "netlist"]),
        request,
        evidence,
      );
      reports.push(
        ercReport,
        schematicNetlistReport,
        derivedReport("connectivity", "reports/kicad/schematic/connectivity.json", request, evidence, [schematicNetlistReport], [], {
          summary: evidence.connectivity,
          schematicNetlist: contentIdentity(netlistBytes),
          firmwareParity: evidence.connectivity.firmwareParity,
          invocation: evidence.inspection.invocations[0],
        }),
      );
    } else if (request.stage === "pcb_placement_routing") {
      const exported = evidence.exported!;
      const pcbBytes = await regularFileBytes(evidence.working.pcbPath, "Isolated KiCad PCB");
      const evaluatedPcbBinding = evidence.sourceBindings.find(
        (binding) => binding.path === `${DESIGN_NAME}.kicad_pcb`,
      );
      const evaluatedPcbIdentity = contentIdentity(pcbBytes);
      if (
        evaluatedPcbBinding === undefined ||
        evaluatedPcbBinding.sha256 !== evaluatedPcbIdentity.digest ||
        evaluatedPcbBinding.sizeBytes !== evaluatedPcbIdentity.size
      ) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_SOURCE_MUTATED",
          "ARTIFACT_INTEGRITY_ERROR",
          "PCB bytes captured for practice analysis differ from the exact native-evaluated source binding.",
        );
      }
      const pcbEngineering = request.pcbEngineering!;
      const pcbPracticeAnalysis: PcbPracticeAnalysis = analyzeKicadPcbPractices(
        pcbBytes,
        pcbEngineering.analyzerProfile.document,
        { sourcePath: `kicad/${DESIGN_NAME}/${DESIGN_NAME}.kicad_pcb` },
      );
      const pcbEngineeringSummary = buildKicadPcbEngineeringDecisionSummary(
        pcbPracticeAnalysis,
        pcbEngineering.engineeringConstraintBinding?.document ?? null,
      );
      const snapshotReference = (snapshot: {
        readonly logicalName: string;
        readonly contentIdentity: ContentIdentity;
        readonly canonicalIdentity: CanonicalIdentity;
      }) => ({
        logicalName: snapshot.logicalName,
        contentIdentity: snapshot.contentIdentity,
        canonicalIdentity: snapshot.canonicalIdentity,
      });
      const engineeringInputs = {
        layoutPlan: {
          logicalName: pcbEngineering.layoutPlan.logicalName,
          contentIdentity: pcbEngineering.layoutPlan.contentIdentity,
        },
        analyzerProfile: snapshotReference(pcbEngineering.analyzerProfile),
        practiceCatalog: snapshotReference(pcbEngineering.practiceCatalog),
        routeQualityPolicy: {
          ...snapshotReference(pcbEngineering.routeQualityPolicy),
          captureIdentity: pcbEngineering.routeQualityPolicy.captureIdentity,
        },
        routeQualityRuleDeck: snapshotReference(pcbEngineering.routeQualityRuleDeck),
        proofFixturePolicy: snapshotReference(pcbEngineering.proofFixturePolicy),
        engineeringConstraintBinding:
          pcbEngineering.engineeringConstraintBinding === null
            ? null
            : {
                ...snapshotReference(pcbEngineering.engineeringConstraintBinding),
                compiledConstraintSetIdentity:
                  pcbEngineering.engineeringConstraintBinding.document
                    .compiledConstraintSetIdentity,
              },
      };
      const analysisIdentity = canonicalIdentity(
        pcbPracticeAnalysis,
        pcbPracticeAnalysis.schemaVersion,
      );
      artifacts.push(
        artifactFromBytes(
          "pcb",
          `kicad/${DESIGN_NAME}/${DESIGN_NAME}.kicad_pcb`,
          mediaTypeFor(evidence.working.pcbPath),
          pcbBytes,
        ),
      );
      const renderArtifacts = exported.artifacts.filter((artifact) =>
        artifact.relativePath.startsWith("renders/"),
      );
      if (renderArtifacts.length < 2) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_OUTPUT_MISSING",
          "TOOL_RESULT_INCONCLUSIVE",
          "KiCad did not produce both reference board renders.",
        );
      }
      for (const renderArtifact of renderArtifacts) {
        artifacts.push(
          artifactFromBytes(
            "render",
            `pcb/${renderArtifact.relativePath}`,
            mediaTypeFor(renderArtifact.relativePath),
            await readExportArtifact(renderArtifact),
          ),
        );
      }
      const netlistBytes = await regularFileBytes(
        evidence.inspection.schematicNetlist.path,
        "KiCad schematic netlist",
      );
      const drcReport = await nativeReport(
        "drc",
        "reports/kicad/pcb/drc.json",
        evidence.checks.drc.reportPath,
        evidence.checks.drc.invocation,
        request,
        evidence,
      );
      const schematicNetlistReport = await nativeReport(
        "schematic_netlist",
        "reports/kicad/pcb/native/schematic-netlist.kicad_net",
        evidence.inspection.schematicNetlist.path,
        invocationFor(evidence.inspection.invocations, ["sch", "export", "netlist"]),
        request,
        evidence,
      );
      const boardStatisticsReport = await nativeReport(
        "board_statistics",
        "reports/kicad/pcb/native/board-statistics.json",
        evidence.inspection.boardStatistics.path,
        invocationFor(evidence.inspection.invocations, ["pcb", "export", "stats"]),
        request,
        evidence,
      );
      const boardNetlistReport = await nativeReport(
        "board_netlist",
        "reports/kicad/pcb/native/board-netlist.d356",
        evidence.inspection.boardNetlist.path,
        invocationFor(evidence.inspection.invocations, ["pcb", "export", "ipcd356"]),
        request,
        evidence,
      );
      reports.push(
        drcReport,
        schematicNetlistReport,
        boardStatisticsReport,
        boardNetlistReport,
        derivedReport("schematic_parity", "reports/kicad/pcb/schematic-parity.json", request, evidence, [drcReport], [], {
          findingCount: evidence.checks.drc.schematicParityCount,
          nativeFindings: evidence.checks.drc.report.schematic_parity,
          invocation: evidence.checks.drc.invocation,
        }),
        derivedReport("connectivity", "reports/kicad/pcb/connectivity.json", request, evidence, [schematicNetlistReport, boardNetlistReport], [], {
          summary: evidence.connectivity,
          schematicNetlist: contentIdentity(netlistBytes),
          boardNetlist: {
            algorithm: "sha256",
            digest: evidence.inspection.boardNetlist.sha256,
            size: evidence.inspection.boardNetlist.sizeBytes,
          },
          invocation: evidence.inspection.invocations,
        }),
        derivedReport("geometry", "reports/kicad/pcb/geometry.json", request, evidence, [boardStatisticsReport], [artifactReportBinding(`kicad/${DESIGN_NAME}/${DESIGN_NAME}.kicad_pcb`, pcbBytes)], {
          copperLayerCount: ROBOTICS_CONTROLLER_V0.stackup.layerCount,
          fabricationGeometry: evidence.fabricationGeometry,
          nativeStatistics: statistics,
          statisticsIdentity: {
            algorithm: "sha256",
            digest: evidence.inspection.boardStatistics.sha256,
            size: evidence.inspection.boardStatistics.sizeBytes,
          },
          invocation: evidence.inspection.invocations[1],
        }),
        derivedReport(
          "pcb_practices",
          "reports/kicad/pcb/pcb-practices.json",
          request,
          evidence,
          [drcReport, boardStatisticsReport],
          [
            artifactReportBinding(
              `kicad/${DESIGN_NAME}/${DESIGN_NAME}.kicad_pcb`,
              pcbBytes,
            ),
            {
              kind: "artifact",
              logicalName: pcbEngineering.layoutPlan.logicalName,
              identity: pcbEngineering.layoutPlan.contentIdentity,
            },
            ...[
              pcbEngineering.analyzerProfile,
              pcbEngineering.practiceCatalog,
              pcbEngineering.routeQualityPolicy,
              pcbEngineering.routeQualityRuleDeck,
              pcbEngineering.proofFixturePolicy,
              ...(pcbEngineering.engineeringConstraintBinding === null
                ? []
                : [pcbEngineering.engineeringConstraintBinding]),
            ].map((snapshot) => ({
              kind: "artifact" as const,
              logicalName: snapshot.logicalName,
              identity: snapshot.contentIdentity,
            })),
          ],
          {
            engineeringInputs,
            analysisIdentity,
            analysis: pcbPracticeAnalysis,
            engineeringSummary: pcbEngineeringSummary,
          },
          pcbEngineeringSummary.machine.status === "pass" ? "pass" : "fail",
        ),
      );
    } else {
      const exported = evidence.exported!;
      const exportContents = new Map<string, Buffer>();
      for (const exportArtifact of exported.artifacts) {
        exportContents.set(exportArtifact.relativePath, await readExportArtifact(exportArtifact));
      }
      const bomBytes = exportContents.get("bom.csv");
      const positionBytes = exportContents.get("positions.csv");
      if (bomBytes === undefined || positionBytes === undefined) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_OUTPUT_MISSING",
          "TOOL_RESULT_INCONCLUSIVE",
          "KiCad BOM or position export is missing.",
        );
      }
      const bom = parseBom(bomBytes, request.profile);
      assertReferenceSetAgreement({
        observed: bom.references,
        expected: evidence.connectivity.schematicReferences,
        relationship: "exact",
        source: "Exported KiCad BOM",
        expectedSource: "the schematic and PCB structural component set",
        failureCode: "REFERENCE_BOM_PARITY_FAILED",
      });
      if (
        canonicalJson(bom.selectedComponents) !==
        canonicalJson(evidence.connectivity.selectedComponents.schematic)
      ) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_BOM_PARITY_FAILED",
          "GATE_FAILED",
          "Exported BOM selected-component metadata differs from the schematic and PCB.",
          {
            bom: bom.selectedComponents,
            schematic: evidence.connectivity.selectedComponents.schematic,
            pcb: evidence.connectivity.selectedComponents.pcb,
          },
        );
      }
      positionSummary = parsePositionSummary(positionBytes);
      const positionInvocation = invocationFor(exported.invocations, ["pcb", "export", "pos"]);
      const runtimePositionSettings = positionExportSettings(positionInvocation.args);
      if (
        canonicalJson(runtimePositionSettings) !==
        canonicalJson(PRODUCTION_POSITION_EXPORT_SETTINGS)
      ) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_POSITION_PARITY_FAILED",
          "TOOL_RESULT_INCONCLUSIVE",
          "KiCad position export invocation disagrees with the production export policy.",
          { expected: PRODUCTION_POSITION_EXPORT_SETTINGS, actual: runtimePositionSettings },
        );
      }
      positionReferencePolicy = pcbPositionReferencePolicy(
        evidence.connectivity.positionReferenceSource,
        runtimePositionSettings,
        bom.dnpReferences,
      );
      assertReferenceSetAgreement({
        observed: positionSummary.references,
        expected: positionReferencePolicy.expectedPositionReferences,
        relationship: "exact",
        source: "Exported KiCad position CSV",
        expectedSource: "the PCB position-export policy",
        failureCode: "REFERENCE_POSITION_PARITY_FAILED",
        details: {
          positionExportPolicy: positionReferencePolicy,
          exportedPositionRowCount: positionSummary.rowCount,
        },
      });
      artifacts.push(
        artifactFromBytes("bom", "manufacturing/bom.csv", "text/csv; charset=utf-8", bomBytes),
        artifactFromBytes(
          "position",
          "manufacturing/positions.csv",
          "text/csv; charset=utf-8",
          positionBytes,
        ),
      );
      for (const [relativePath, bytes] of exportContents) {
        if (
          relativePath.startsWith("gerbers/") &&
          (relativePath.endsWith(".gbr") || relativePath.endsWith(".gbrjob"))
        ) {
          artifacts.push(
            artifactFromBytes(
              "gerber",
              `manufacturing/${relativePath}`,
              mediaTypeFor(relativePath),
              bytes,
            ),
          );
        } else if (
          relativePath.startsWith("drill/") &&
          (relativePath.endsWith(".drl") ||
            relativePath.endsWith(".rpt") ||
            relativePath.endsWith(".svg"))
        ) {
          artifacts.push(
            artifactFromBytes(
              "drill",
              `manufacturing/${relativePath}`,
              mediaTypeFor(relativePath),
              bytes,
            ),
          );
        }
      }
      if (!artifacts.some((artifact) => artifact.role === "gerber")) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_OUTPUT_MISSING",
          "TOOL_RESULT_INCONCLUSIVE",
          "KiCad produced no Gerber artifacts.",
        );
      }
      if (!artifacts.some((artifact) => artifact.role === "drill" && artifact.logicalName.endsWith(".drl"))) {
        throw new ReferenceKicadBackendError(
          "REFERENCE_OUTPUT_MISSING",
          "TOOL_RESULT_INCONCLUSIVE",
          "KiCad produced no Excellon drill artifact.",
        );
      }

      const requestBinding = referenceKicadRequestBinding(request);
      const camManifest = {
        schemaVersion: REFERENCE_KICAD_CAM_SCHEMA,
        classification: "candidate",
        lifecycle: "candidate",
        releaseAuthorized: false,
        warning: "ENGINEERING CANDIDATE - NOT AUTHORIZED FOR MANUFACTURING",
        sourceRevisionDigest: request.expectedSourceRevisionDigest,
        requestBinding,
        provenance: templateReuseProvenance(requestBinding),
        canonicalValidation: {
          manifestIdentity: evidence.canonical.validationIdentity,
          validationRoot: evidence.canonical.validationRoot,
          regeneration: evidence.canonical.regeneration,
        },
        fabricationGeometry: evidence.fabricationGeometry,
        unresolvedAssumptions: evidence.canonical.qualificationOnlyAssumptions,
        executable: evidence.adapter.identity,
        sourceBindings: evidence.sourceBindings,
        artifacts: artifacts.map((artifact) => outputBinding(artifact.logicalName, artifact.content)),
        invocations: exported.invocations,
      };
      const camBytes = Buffer.from(canonicalJson(camManifest), "utf8");
      artifacts.push(
        artifactFromBytes(
          "cam_manifest",
          "manufacturing/cam-manifest.json",
          JSON_MEDIA_TYPE,
          camBytes,
        ),
      );
      const byRole = (role: KicadArtifactRole) =>
        artifacts.filter((artifact) => artifact.role === role).map((artifact) => outputBinding(artifact.logicalName, artifact.content));
      const authorityByRole = (role: KicadArtifactRole): readonly KicadReportInputBinding[] =>
        artifacts
          .filter((artifact) => artifact.role === role)
          .map((artifact) => artifactReportBinding(artifact.logicalName, artifact.content));
      const drcReport = await nativeReport(
        "drc",
        "reports/kicad/manufacturing/drc.json",
        evidence.checks.drc.reportPath,
        evidence.checks.drc.invocation,
        request,
        evidence,
      );
      const schematicNetlistReport = await nativeReport(
        "schematic_netlist",
        "reports/kicad/manufacturing/native/schematic-netlist.kicad_net",
        evidence.inspection.schematicNetlist.path,
        invocationFor(evidence.inspection.invocations, ["sch", "export", "netlist"]),
        request,
        evidence,
      );
      const boardStatisticsReport = await nativeReport(
        "board_statistics",
        "reports/kicad/manufacturing/native/board-statistics.json",
        evidence.inspection.boardStatistics.path,
        invocationFor(evidence.inspection.invocations, ["pcb", "export", "stats"]),
        request,
        evidence,
      );
      const boardNetlistReport = await nativeReport(
        "board_netlist",
        "reports/kicad/manufacturing/native/board-netlist.d356",
        evidence.inspection.boardNetlist.path,
        invocationFor(evidence.inspection.invocations, ["pcb", "export", "ipcd356"]),
        request,
        evidence,
      );
      reports.push(
        drcReport,
        schematicNetlistReport,
        boardStatisticsReport,
        boardNetlistReport,
        derivedReport(
          "schematic_parity",
          "reports/kicad/manufacturing/schematic-parity.json",
          request,
          evidence,
          [drcReport],
          [],
          {
            findingCount: evidence.checks.drc.schematicParityCount,
            nativeFindings: evidence.checks.drc.report.schematic_parity,
            invocation: evidence.checks.drc.invocation,
          },
        ),
        derivedReport("bom_parity", "reports/kicad/manufacturing/bom-parity.json", request, evidence, [schematicNetlistReport, boardNetlistReport], authorityByRole("bom"), {
          status: "pass",
          bom,
          schematicReferences: evidence.connectivity.schematicReferences,
          pcbReferences: evidence.connectivity.pcbReferences,
        }),
        derivedReport("bom_export", "reports/kicad/manufacturing/bom-export.json", request, evidence, [drcReport], authorityByRole("bom"), {
          outputs: byRole("bom"),
          invocation: invocationFor(exported.invocations, ["sch", "export", "bom"]),
        }),
        derivedReport("gerber_export", "reports/kicad/manufacturing/gerber-export.json", request, evidence, [drcReport], authorityByRole("gerber"), {
          outputs: byRole("gerber"),
          invocation: invocationFor(exported.invocations, ["pcb", "export", "gerbers"]),
        }),
        derivedReport("drill_export", "reports/kicad/manufacturing/drill-export.json", request, evidence, [drcReport], authorityByRole("drill"), {
          outputs: byRole("drill"),
          invocation: invocationFor(exported.invocations, ["pcb", "export", "drill"]),
        }),
        derivedReport("position_export", "reports/kicad/manufacturing/position-export.json", request, evidence, [drcReport], authorityByRole("position"), {
          outputs: byRole("position"),
          invocation: invocationFor(exported.invocations, ["pcb", "export", "pos"]),
          referencePolicy: {
            ...positionReferencePolicy,
            exportedReferences: positionSummary.references,
            exportedRowCount: positionSummary.rowCount,
          },
        }),
        derivedReport("cam_manifest", "reports/kicad/manufacturing/cam-manifest.json", request, evidence, [drcReport, boardStatisticsReport], artifacts.map((artifact) => artifactReportBinding(artifact.logicalName, artifact.content)), {
          output: outputBinding("manufacturing/cam-manifest.json", camBytes),
          boundOutputCount: artifacts.length - 1,
        }),
      );
    }

    return {
      schemaVersion: "evleda.kicad-result.v2",
      stage: request.stage,
      sourceRevisionDigest: request.expectedSourceRevisionDigest,
      tool: toolIdentity(evidence.adapter.identity),
      artifacts,
      reports,
    };
  }
}

export const createReferenceKicadBackend = (
  options: ReferenceKicadBackendOptions,
): KicadGenerationBackend => new ReferenceKicadBackend(options);

// Portable Validation v3 is intentionally exported beside, not substituted
// for, the legacy reference backend. Application/state wiring is a later gate.
export {
  PortableKicadProducerV3,
  PortableKicadProducerV3Error,
  buildKicadBackendRequestV3,
  consumeKicadBackendResultV3,
  createPortableKicadProducerV3,
  validateKicadBackendRequestV3,
  validateKicadBackendResultV3,
} from "./portable-kicad-producer.js";

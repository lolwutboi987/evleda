import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { isProxy } from "node:util/types";
import {
  contentIdentitySchema,
  requirementsDocumentSchema
} from "../contracts/results.js";
import type {
  CanonicalIdentity,
  ContentIdentity,
  ToolIdentity,
  ValidationStatus
} from "../domain/types.js";
import type {
  PowerRailContract,
  ReferenceComponentKey,
  ReferenceControllerProfile
} from "../knowledge/reference-controller-v0.js";
import { createReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
  referenceControllerRevASourceBinding,
  type ReferenceNativeSourceBinding
} from "../knowledge/reference-controller-native-contract.js";
import type {
  SimulationBackend,
  SimulationBackendResult,
  SimulationCoverageItem,
  SimulationReport,
  SimulationRequest
} from "../workflow/contracts.js";

export const REFERENCE_SIMULATION_BACKEND_ID =
  "evleda.reference-simulation.robotics-controller-v0.v2";
export const REFERENCE_SIMULATION_MODEL_VERSION = "2.2.0";
export const REFERENCE_SIMULATION_MODEL_SCHEMA =
  "evleda.reference-simulation-model.v2";
export const REFERENCE_SIMULATION_REPORT_SCHEMA =
  "evleda.reference-simulation-report.v2";
export const REFERENCE_SIMULATION_NATIVE_TOPOLOGY_SOURCE_SCHEMA =
  "evleda.reference-simulation-native-topology-source.v1";

const COVERAGE_ITEMS: readonly SimulationCoverageItem[] = [
  "power_tree_operating_points",
  "logic_rail_load_budget",
  "motor_current_chop",
  "motor_driver_thermal",
  "fault_and_reset"
];

const PPM = 1_000_000;
const HEADROOM_PPM = 200_000;
const ONE_PERCENT_PPM = 10_000;
const textEncoder = new TextEncoder();

type CheckStatus = "pass" | "fail" | "unsupported" | "not_run";
type ParameterKind =
  | "datasheet_limit"
  | "datasheet_typical"
  | "profile_contract"
  | "revision_a_design_value"
  | "model_assumption";

interface SourceLocation {
  readonly id: string;
  readonly manufacturer: string;
  readonly document: string;
  readonly sourceUrl: string;
  readonly fileName: string;
  readonly byteIdentity: {
    readonly algorithm: "sha256";
    readonly digest: string;
    readonly size: number;
  };
  /** 1-based page index in the exact PDF byte stream. */
  readonly pdfPages: readonly number[];
  readonly pdfPageNumbering: "1-based";
  /** Human-visible page label printed in the document footer/header. */
  readonly printedPages: readonly string[];
  readonly section: string;
}

interface ModelParameter {
  readonly id: string;
  readonly value: number | string | null;
  readonly unit: string;
  readonly kind: ParameterKind;
  readonly sourceIds: readonly string[];
  readonly note: string;
}

interface ModelEquation {
  readonly id: string;
  readonly expression: string;
  readonly arithmetic: string;
  readonly sourceIds: readonly string[];
}

export interface ReferenceSimulationCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly actual: Readonly<Record<string, boolean | number | string | null>>;
  readonly acceptance: string;
  readonly detail: string;
}

export interface ReferenceSimulationModel {
  readonly schemaVersion: typeof REFERENCE_SIMULATION_MODEL_SCHEMA;
  readonly modelVersion: typeof REFERENCE_SIMULATION_MODEL_VERSION;
  readonly coverageItem: SimulationCoverageItem;
  readonly criticScope: string;
  readonly profileBinding: Readonly<Record<string, unknown>>;
  readonly equations: readonly ModelEquation[];
  readonly parameters: readonly ModelParameter[];
  readonly sources: readonly SourceLocation[];
  readonly toleranceAssumptions: Readonly<Record<string, unknown>>;
  readonly ambientCopperAndDutyAssumptions: Readonly<Record<string, unknown>>;
  readonly unsupportedSubcoverage: readonly string[];
  readonly evidenceInputs: readonly ReferenceSimulationEvidenceInput[];
}

export interface ReferenceSimulationEvidenceInput {
  readonly role: "native_schematic_topology";
  readonly logicalName: string;
  readonly identity: ContentIdentity;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly canonicalSourceBinding: ReferenceNativeSourceBinding;
  readonly bindingStatus: "bound" | "unbound";
}

export interface ReferenceSimulationNativeTopologySource {
  readonly schemaVersion: typeof REFERENCE_SIMULATION_NATIVE_TOPOLOGY_SOURCE_SCHEMA;
  readonly logicalName: string;
  readonly identity: ContentIdentity;
  readonly content: Uint8Array;
}

export interface ReferenceSimulationBackendOptions {
  readonly nativeTopologySource?: ReferenceSimulationNativeTopologySource;
}

type ResetBiasFindingCode =
  | "NATIVE_NET_MISSING"
  | "REQUIRED_ENDPOINT_MISSING"
  | "BIAS_RESISTOR_MISSING"
  | "BIAS_RESISTOR_AMBIGUOUS"
  | "BIAS_COMPONENT_TYPE_MISMATCH"
  | "BIAS_RESISTOR_TOPOLOGY_INVALID"
  | "BIAS_RESISTOR_REUSED"
  | "BIAS_RAIL_MISMATCH"
  | "BIAS_VALUE_MISMATCH";

interface NativeNetEndpoint {
  readonly reference: string;
  readonly pin: string;
}

interface NativeComponentDefinition {
  readonly value: string;
  readonly library: string;
  readonly part: string;
  readonly declaredPins: readonly string[];
}

interface NativeReferenceNode {
  readonly netName: string;
  readonly pin: string;
}

interface NativeBiasResistorObservation {
  readonly reference: string;
  readonly value: string;
  readonly resistanceOhm: number | null;
  readonly componentLibrary: string;
  readonly componentPart: string;
  readonly resistorTypeValid: boolean;
  readonly connectedPins: readonly string[];
  readonly connectedNets: readonly string[];
}

export interface ResetBiasTopologyFact {
  readonly signal: string;
  readonly nativeNetName: string;
  readonly safeRailNetName: "+3V3" | "GND";
  readonly expectedResistanceOhm: number;
  readonly requiredEndpoints: readonly NativeNetEndpoint[];
  readonly observedEndpoints: readonly NativeNetEndpoint[];
  readonly observedBiasResistors: readonly NativeBiasResistorObservation[];
  readonly findings: readonly ResetBiasFindingCode[];
  readonly status: "pass" | "fail";
}

export interface ReferenceSimulationTopologyDiagnostics {
  readonly schemaVersion: "evleda.reference-simulation-topology-diagnostics.v1";
  readonly authority: "diagnostic_only_not_evidence";
  readonly sourceLogicalName: string;
  readonly sourceIdentity: ContentIdentity;
  readonly canonicalSourceMatch: boolean;
  readonly facts: readonly ResetBiasTopologyFact[];
  readonly passingFactCount: number;
  readonly failingFactCount: number;
}

interface NativeResetTopologyEvidence {
  readonly schemaVersion: "evleda.reference-reset-topology-evidence.v1";
  readonly sourceLogicalName: string;
  readonly sourceIdentity: ContentIdentity;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly canonicalSourceBinding: ReferenceNativeSourceBinding;
  readonly facts: readonly ResetBiasTopologyFact[];
  readonly passingFactCount: number;
  readonly failingFactCount: number;
}

interface PreparedNativeTopologySource {
  readonly logicalName: string;
  readonly identity: ContentIdentity;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly canonicalSourceBinding: ReferenceNativeSourceBinding;
  readonly evidence: NativeResetTopologyEvidence;
}

export interface ReferenceSimulationReportDocument {
  readonly schemaVersion: typeof REFERENCE_SIMULATION_REPORT_SCHEMA;
  readonly coverageItem: SimulationCoverageItem;
  readonly sourceRevisionDigest: string;
  readonly modelIdentity: CanonicalIdentity;
  readonly model: ReferenceSimulationModel;
  readonly validationStatus: ValidationStatus;
  readonly checks: readonly ReferenceSimulationCheck[];
  readonly conclusion: string;
  readonly evidenceBoundary: readonly string[];
}

interface ModelBuild {
  readonly model: ReferenceSimulationModel;
  readonly checks: readonly ReferenceSimulationCheck[];
  readonly conclusion: string;
}

const pdfSource = (
  id: string,
  manufacturer: string,
  document: string,
  sourceUrl: string,
  fileName: string,
  size: number,
  digest: string,
  pdfPages: readonly number[],
  printedPages: readonly string[],
  section: string
): SourceLocation => ({
  id,
  manufacturer,
  document,
  sourceUrl,
  fileName,
  byteIdentity: { algorithm: "sha256", digest, size },
  pdfPages,
  pdfPageNumbering: "1-based",
  printedPages,
  section
});

const SOURCES = {
  drvElectrical: pdfSource(
    "drv8874-electrical-characteristics",
    "Texas Instruments",
    "DRV8874 SLVSF66A",
    "https://www.ti.com/lit/ds/symlink/drv8874.pdf",
    "drv8874.pdf",
    2_536_495,
    "e28fdb554c58e0c949a21f825a7c985bafc807e9f190575eb02d531afb715c64",
    [5, 6],
    ["5", "6"],
    "6.4 Thermal Information and 6.5 Electrical Characteristics"
  ),
  drvRegulation: pdfSource(
    "drv8874-current-regulation",
    "Texas Instruments",
    "DRV8874 SLVSF66A",
    "https://www.ti.com/lit/ds/symlink/drv8874.pdf",
    "drv8874.pdf",
    2_536_495,
    "e28fdb554c58e0c949a21f825a7c985bafc807e9f190575eb02d531afb715c64",
    [12, 13, 14],
    ["12", "13", "14"],
    "7.3.3 Current Sense and Regulation, Equations 1-3 and Table 6"
  ),
  drvProtection: pdfSource(
    "drv8874-protection",
    "Texas Instruments",
    "DRV8874 SLVSF66A",
    "https://www.ti.com/lit/ds/symlink/drv8874.pdf",
    "drv8874.pdf",
    2_536_495,
    "e28fdb554c58e0c949a21f825a7c985bafc807e9f190575eb02d531afb715c64",
    [17],
    ["17"],
    "7.3.4 Protection Circuits and Table 7 Fault Condition Summary"
  ),
  drvApplication: pdfSource(
    "drv8874-typical-application",
    "Texas Instruments",
    "DRV8874 SLVSF66A",
    "https://www.ti.com/lit/ds/symlink/drv8874.pdf",
    "drv8874.pdf",
    2_536_495,
    "e28fdb554c58e0c949a21f825a7c985bafc807e9f190575eb02d531afb715c64",
    [21, 22],
    ["21", "22"],
    "8.2.1.1 Design Requirements and 8.2.1.2 Detailed Design Procedure, Equations 4-22"
  ),
  lmrVariants: pdfSource(
    "lmr51420-device-variants",
    "Texas Instruments",
    "LMR51420 SLUSEF6C",
    "https://www.ti.com/lit/ds/symlink/lmr51420.pdf",
    "lmr51420.pdf",
    2_117_875,
    "8cc7e8bc4ef9adbaaebf47d6059a847796b004ad3cd82ce99102a0fa590693ea",
    [3],
    ["3"],
    "5 Device Comparison Table"
  ),
  lmrElectrical: pdfSource(
    "lmr51420-electrical-characteristics",
    "Texas Instruments",
    "LMR51420 SLUSEF6C",
    "https://www.ti.com/lit/ds/symlink/lmr51420.pdf",
    "lmr51420.pdf",
    2_117_875,
    "8cc7e8bc4ef9adbaaebf47d6059a847796b004ad3cd82ce99102a0fa590693ea",
    [5, 6],
    ["5", "6"],
    "7.4 Thermal Information, 7.5 Electrical Characteristics, and 7.6 System Characteristics"
  ),
  lmrApplication: pdfSource(
    "lmr51420-application",
    "Texas Instruments",
    "LMR51420 SLUSEF6C",
    "https://www.ti.com/lit/ds/symlink/lmr51420.pdf",
    "lmr51420.pdf",
    2_117_875,
    "8cc7e8bc4ef9adbaaebf47d6059a847796b004ad3cd82ce99102a0fa590693ea",
    [16, 17, 18, 21],
    ["16", "17", "18", "21"],
    "9.2 Typical Application, 9.2.2 Detailed Design Procedure, and 9.4 Layout"
  ),
  tlvElectrical: pdfSource(
    "tlv755p-electrical-characteristics",
    "Texas Instruments",
    "TLV755P SBVS320D",
    "https://www.ti.com/lit/ds/symlink/tlv755p.pdf",
    "tlv755p.pdf",
    3_072_276,
    "c0fe7be9fea4e4c8d933142f59758f7a951e195a45ca4e7e17684153da018cbb",
    [5, 6],
    ["5", "6"],
    "5.4 Thermal Information and 5.5 Electrical Characteristics"
  ),
  tlvModes: pdfSource(
    "tlv755p-modes-and-thermal",
    "Texas Instruments",
    "TLV755P SBVS320D",
    "https://www.ti.com/lit/ds/symlink/tlv755p.pdf",
    "tlv755p.pdf",
    3_072_276,
    "c0fe7be9fea4e4c8d933142f59758f7a951e195a45ca4e7e17684153da018cbb",
    [12, 13, 14, 20],
    ["12", "13", "14", "20"],
    "6.3 Feature Description, 6.4 Device Functional Modes, and 7.2.2 Detailed Design Procedure"
  ),
  tcanSupply: pdfSource(
    "tcan3413-supply-characteristics",
    "Texas Instruments",
    "TCAN3413 SLLSFS8A",
    "https://www.ti.com/lit/ds/symlink/tcan3413.pdf",
    "tcan3413.pdf",
    2_080_472,
    "2c0e8963e7762bc91edf30a365cc10c31ce88e2ddda3b67a120c4158ae52930b",
    [5, 6],
    ["5", "6"],
    "5.6 Supply Characteristics and 5.7 Dissipation Ratings"
  ),
  tcanModes: pdfSource(
    "tcan3413-protected-modes",
    "Texas Instruments",
    "TCAN3413 SLLSFS8A",
    "https://www.ti.com/lit/ds/symlink/tcan3413.pdf",
    "tcan3413.pdf",
    2_080_472,
    "2c0e8963e7762bc91edf30a365cc10c31ce88e2ddda3b67a120c4158ae52930b",
    [9, 17, 18, 19, 20, 21],
    ["9", "17", "18", "19", "20", "21"],
    "5.9 Switching Characteristics and 7.3-7.4 Protected/Operating Modes"
  ),
  bufferElectrical: pdfSource(
    "sn74lvc2g17-electrical-characteristics",
    "Texas Instruments",
    "SN74LVC2G17 SCES381N",
    "https://www.ti.com/lit/ds/symlink/sn74lvc2g17.pdf",
    "sn74lvc2g17.pdf",
    1_888_823,
    "624dbe55679d2fed4123b0d7708cd0d295efcc78de395e71a0caf5cd13cbc216",
    [4, 5, 6],
    ["4", "5", "6"],
    "7.1 Absolute Maximum Ratings through 7.8 Operating Characteristics"
  ),
  tpsElectrical: pdfSource(
    "tps2553-electrical-characteristics",
    "Texas Instruments",
    "TPS2552/53 SLVS841F",
    "https://www.ti.com/lit/ds/symlink/tps2553.pdf",
    "tps2553.pdf",
    2_091_685,
    "8ab20570d3e126d7a13719135f2b6a8858244de7f6c771d7a4329b23e06afca8",
    [5, 6, 7],
    ["5", "6", "7"],
    "6 Pin Configuration and Functions and 7 Specifications"
  ),
  tpsLatch: pdfSource(
    "tps2553-latch-off-operation",
    "Texas Instruments",
    "TPS2552/53 SLVS841F",
    "https://www.ti.com/lit/ds/symlink/tps2553.pdf",
    "tps2553.pdf",
    2_091_685,
    "8ab20570d3e126d7a13719135f2b6a8858244de7f6c771d7a4329b23e06afca8",
    [13, 14, 15, 17, 20, 24],
    ["13", "14", "15", "17", "20", "24"],
    "9.3 Feature Description, 9.5 Programming, 10.1.1 Latch-Off Operation, and 11.3 Thermal"
  ),
  stmCurrent: pdfSource(
    "stm32g0b1-current-limits",
    "STMicroelectronics",
    "STM32G0B1xB/xC/xE DS13560 Rev 6",
    "https://www.st.com/resource/en/datasheet/stm32g0b1cb.pdf",
    "stm32g0b1cb.pdf",
    3_971_768,
    "8433e47bc5da5cac459a1d3d5a6add183655061f5655d3c653248de65ca535c9",
    [66, 71, 72],
    ["66/165", "71/165", "72/165"],
    "5.1.7 Current Consumption Measurement, Table 22, and 5.3.5 Supply Current Characteristics"
  ),
  stmReset: pdfSource(
    "stm32g0b1-reset-and-brownout",
    "STMicroelectronics",
    "STM32G0B1xB/xC/xE DS13560 Rev 6",
    "https://www.st.com/resource/en/datasheet/stm32g0b1cb.pdf",
    "stm32g0b1cb.pdf",
    3_971_768,
    "8433e47bc5da5cac459a1d3d5a6add183655061f5655d3c653248de65ca535c9",
    [68, 69],
    ["68/165", "69/165"],
    "5.3.2 Power-up/Power-down and 5.3.3 Embedded Reset and Power Control"
  ),
  usbProtection: pdfSource(
    "usblc6-2-electrical-and-layout",
    "STMicroelectronics",
    "USBLC6-2 DS4260 Rev 7",
    "https://www.st.com/resource/en/datasheet/usblc6-2.pdf",
    "usblc6-2.pdf",
    575_521,
    "bc30154f310cd631043214ed52571daefe04270587ec55072d49a23bd18b9068",
    [1, 2, 4, 5, 6],
    ["1/20", "2/20", "4/20", "5/20", "6/20"],
    "Features, Table 2 Electrical Characteristics, and 2 Technical Information"
  )
} as const;

const EXPECTED_COMPONENTS: Readonly<
  Record<
    ReferenceComponentKey,
    {
      readonly manufacturer: string;
      readonly partNumber: string;
      readonly package: string;
      readonly footprint: string;
      readonly datasheetUrl: string;
      readonly datasheetSize: number;
      readonly datasheetDigest: string;
    }
  >
> = {
  mcu: {
    manufacturer: "STMicroelectronics",
    partNumber: "STM32G0B1CET6",
    package: "LQFP-48",
    footprint: "Package_QFP:LQFP-48_7x7mm_P0.5mm",
    datasheetUrl: "https://www.st.com/resource/en/datasheet/stm32g0b1cb.pdf",
    datasheetSize: 3_971_768,
    datasheetDigest: "8433e47bc5da5cac459a1d3d5a6add183655061f5655d3c653248de65ca535c9"
  },
  motor_driver: {
    manufacturer: "Texas Instruments",
    partNumber: "DRV8874PWPR",
    package: "HTSSOP-16 PowerPAD (PWP)",
    footprint: "robotics_motor:DRV8874_PWP0016J",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/drv8874.pdf",
    datasheetSize: 2_536_495,
    datasheetDigest: "e28fdb554c58e0c949a21f825a7c985bafc807e9f190575eb02d531afb715c64"
  },
  buck_5v: {
    manufacturer: "Texas Instruments",
    partNumber: "LMR51420XFDDCR",
    package: "SOT-23-6 (DDC)",
    footprint: "robotics_power:TI_DDC0006A",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/lmr51420.pdf",
    datasheetSize: 2_117_875,
    datasheetDigest: "8cc7e8bc4ef9adbaaebf47d6059a847796b004ad3cd82ce99102a0fa590693ea"
  },
  ldo_3v3: {
    manufacturer: "Texas Instruments",
    partNumber: "TLV75533PDBVR",
    package: "SOT-23-5 (DBV)",
    footprint: "Package_TO_SOT_SMD:SOT-23-5",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/tlv755p.pdf",
    datasheetSize: 3_072_276,
    datasheetDigest: "c0fe7be9fea4e4c8d933142f59758f7a951e195a45ca4e7e17684153da018cbb"
  },
  can_transceiver: {
    manufacturer: "Texas Instruments",
    partNumber: "TCAN3413DR",
    package: "SOIC-8 (D)",
    footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/tcan3413.pdf",
    datasheetSize: 2_080_472,
    datasheetDigest: "2c0e8963e7762bc91edf30a365cc10c31ce88e2ddda3b67a120c4158ae52930b"
  },
  usb_esd: {
    manufacturer: "STMicroelectronics",
    partNumber: "USBLC6-2SC6",
    package: "SOT-23-6L",
    footprint: "Package_TO_SOT_SMD:SOT-23-6",
    datasheetUrl: "https://www.st.com/resource/en/datasheet/usblc6-2.pdf",
    datasheetSize: 575_521,
    datasheetDigest: "bc30154f310cd631043214ed52571daefe04270587ec55072d49a23bd18b9068"
  },
  encoder_buffer: {
    manufacturer: "Texas Instruments",
    partNumber: "SN74LVC2G17DBVR",
    package: "SOT-23-6 (DBV)",
    footprint: "Package_TO_SOT_SMD:SOT-23-6",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/sn74lvc2g17.pdf",
    datasheetSize: 1_888_823,
    datasheetDigest: "624dbe55679d2fed4123b0d7708cd0d295efcc78de395e71a0caf5cd13cbc216"
  },
  sensor_power_switch: {
    manufacturer: "Texas Instruments",
    partNumber: "TPS2553DBVR-1",
    package: "SOT-23-6 (DBV)",
    footprint: "Package_TO_SOT_SMD:SOT-23-6",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/tps2553.pdf",
    datasheetSize: 2_091_685,
    datasheetDigest: "8ab20570d3e126d7a13719135f2b6a8858244de7f6c771d7a4329b23e06afca8"
  }
};

const EXPECTED_INTERFACES = ["USB", "CAN", "UART", "I2C", "SPI", "SWD", "ENCODER"];
const EXPECTED_LAYERS = [
  "F.Cu",
  "In1.Signal",
  "In2.GND",
  "In3.Power",
  "In4.Signal",
  "B.Cu",
];

const parameter = (
  id: string,
  value: number | string | null,
  unit: string,
  kind: ParameterKind,
  sourceIds: readonly string[],
  note: string
): ModelParameter => ({ id, value, unit, kind, sourceIds, note });

const equation = (
  id: string,
  expression: string,
  arithmetic: string,
  sourceIds: readonly string[] = []
): ModelEquation => ({ id, expression, arithmetic, sourceIds });

const check = (
  id: string,
  status: CheckStatus,
  actual: Readonly<Record<string, boolean | number | string | null>>,
  acceptance: string,
  detail: string
): ReferenceSimulationCheck => ({ id, status, actual, acceptance, detail });

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

type SimulationInputIssueCode =
  | "INPUT_ACCESSOR_REJECTED"
  | "INPUT_CYCLE_REJECTED"
  | "INPUT_DEPTH_EXCEEDED"
  | "INPUT_FRACTIONAL_NUMBER"
  | "INPUT_INSPECTION_FAILED"
  | "INPUT_IDENTITY_MISMATCH"
  | "INPUT_NONFINITE_NUMBER"
  | "INPUT_NONPLAIN_VALUE"
  | "INPUT_REQUIRED_NUMBER_MISSING"
  | "INPUT_NUMBER_OUT_OF_RANGE"
  | "INPUT_SIZE_EXCEEDED"
  | "INPUT_STRUCTURE_INVALID"
  | "INPUT_UNKNOWN_FIELD"
  | "INPUT_UNSAFE_INTEGER";

interface SimulationInputIssue {
  readonly code: SimulationInputIssueCode;
  readonly path: string;
}

class SimulationInputSnapshotError extends Error {
  public constructor(
    public readonly issue: SimulationInputIssue
  ) {
    super(issue.code);
    this.name = "SimulationInputSnapshotError";
  }
}

type SimulationInputSnapshot =
  | { readonly status: "valid"; readonly request: SimulationRequest }
  | {
      readonly status: "unsupported";
      readonly sourceRevisionDigest: string;
      readonly issue: SimulationInputIssue;
    };

const snapshotFailure = (code: SimulationInputIssueCode, path: string): never => {
  throw new SimulationInputSnapshotError({ code, path });
};

const safeSourceRevisionDigest = (value: unknown): string => {
  try {
    if (value === null || typeof value !== "object") return "0".repeat(64);
    if (isProxy(value)) return "0".repeat(64);
    const descriptor = Object.getOwnPropertyDescriptor(value, "expectedSourceRevisionDigest");
    return descriptor !== undefined && "value" in descriptor &&
      typeof descriptor.value === "string" && /^[0-9a-f]{64}$/u.test(descriptor.value)
      ? descriptor.value
      : "0".repeat(64);
  } catch {
    return "0".repeat(64);
  }
};

const snapshotPlainSimulationData = (value: unknown): unknown => {
  const active = new WeakSet<object>();
  const memo = new WeakMap<object, unknown>();
  let visited = 0;
  const copy = (entry: unknown, path: string, depth: number): unknown => {
    if (depth > 64) return snapshotFailure("INPUT_DEPTH_EXCEEDED", path);
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) return snapshotFailure("INPUT_NONFINITE_NUMBER", path);
      if (!Number.isInteger(entry)) return snapshotFailure("INPUT_FRACTIONAL_NUMBER", path);
      if (!Number.isSafeInteger(entry)) return snapshotFailure("INPUT_UNSAFE_INTEGER", path);
      return entry;
    }
    if (typeof entry !== "object") return snapshotFailure("INPUT_NONPLAIN_VALUE", path);
    if (isProxy(entry)) return snapshotFailure("INPUT_NONPLAIN_VALUE", path);
    if (active.has(entry)) return snapshotFailure("INPUT_CYCLE_REJECTED", path);
    const prior = memo.get(entry);
    if (prior !== undefined) return prior;
    if (++visited > 50_000) return snapshotFailure("INPUT_SIZE_EXCEEDED", path);
    let prototype: object | null;
    let keys: readonly PropertyKey[];
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(entry) as object | null;
      keys = Reflect.ownKeys(entry);
      descriptors = Object.getOwnPropertyDescriptors(entry);
    } catch {
      return snapshotFailure("INPUT_INSPECTION_FAILED", path);
    }
    active.add(entry);
    if (Array.isArray(entry)) {
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor !== undefined && "value" in lengthDescriptor &&
        Number.isSafeInteger(lengthDescriptor.value)
        ? lengthDescriptor.value as number
        : -1;
      if (prototype !== Array.prototype || length < 0 || length > 10_000) {
        return snapshotFailure("INPUT_NONPLAIN_VALUE", path);
      }
      const allowed = new Set<PropertyKey>(["length"]);
      const output: unknown[] = [];
      memo.set(entry, output);
      for (let index = 0; index < length; index += 1) {
        const key = index.toString();
        allowed.add(key);
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          return snapshotFailure("INPUT_ACCESSOR_REJECTED", `${path}[${key}]`);
        }
        output.push(copy(descriptor.value, `${path}[${key}]`, depth + 1));
      }
      if (keys.some((key) => typeof key === "symbol" || !allowed.has(key))) {
        return snapshotFailure("INPUT_NONPLAIN_VALUE", path);
      }
      active.delete(entry);
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      return snapshotFailure("INPUT_NONPLAIN_VALUE", path);
    }
    if (keys.length > 1_000 || keys.some((key) => typeof key === "symbol")) {
      return snapshotFailure("INPUT_SIZE_EXCEEDED", path);
    }
    const output = Object.create(null) as Record<string, unknown>;
    memo.set(entry, output);
    const sortedKeys = [...keys as readonly string[]].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    for (const key of sortedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        return snapshotFailure("INPUT_ACCESSOR_REJECTED", `${path}.${key}`);
      }
      Object.defineProperty(output, key, {
        value: copy(descriptor.value, `${path}.${key}`, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    active.delete(entry);
    return output;
  };
  return copy(value, "$", 0);
};

const recordValue = (value: unknown, path: string): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : snapshotFailure("INPUT_NONPLAIN_VALUE", path);

const arrayValue = (value: unknown, path: string): readonly unknown[] =>
  Array.isArray(value) ? value : snapshotFailure("INPUT_NONPLAIN_VALUE", path);

const requiredInteger = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number => {
  if (typeof value !== "number") return snapshotFailure("INPUT_REQUIRED_NUMBER_MISSING", path);
  if (!Number.isFinite(value)) return snapshotFailure("INPUT_NONFINITE_NUMBER", path);
  if (!Number.isInteger(value)) return snapshotFailure("INPUT_FRACTIONAL_NUMBER", path);
  if (!Number.isSafeInteger(value)) return snapshotFailure("INPUT_UNSAFE_INTEGER", path);
  if (value < minimum || value > maximum) {
    return snapshotFailure("INPUT_NUMBER_OUT_OF_RANGE", path);
  }
  return value;
};

const validateSimulationNumericDomain = (request: Record<string, unknown>): void => {
  const profile = recordValue(request.profile, "$.profile");
  const inputVoltage = recordValue(profile.inputVoltageMv, "$.profile.inputVoltageMv");
  const inputMinimum = requiredInteger(
    inputVoltage.minimum,
    "$.profile.inputVoltageMv.minimum",
    1,
    100_000
  );
  const inputMaximum = requiredInteger(
    inputVoltage.maximum,
    "$.profile.inputVoltageMv.maximum",
    1,
    100_000
  );
  if (inputMinimum > inputMaximum) {
    return snapshotFailure("INPUT_NUMBER_OUT_OF_RANGE", "$.profile.inputVoltageMv");
  }
  const motor = recordValue(profile.motor, "$.profile.motor");
  requiredInteger(motor.channels, "$.profile.motor.channels", 1, 64);
  requiredInteger(
    motor.rmsCurrentMaPerChannel,
    "$.profile.motor.rmsCurrentMaPerChannel",
    1,
    100_000
  );
  requiredInteger(
    motor.currentChopMaPerChannel,
    "$.profile.motor.currentChopMaPerChannel",
    1,
    100_000
  );
  const stackup = recordValue(profile.stackup, "$.profile.stackup");
  requiredInteger(stackup.layerCount, "$.profile.stackup.layerCount", 1, 128);

  const rails = arrayValue(profile.rails, "$.profile.rails");
  if (rails.length === 0) return snapshotFailure("INPUT_REQUIRED_NUMBER_MISSING", "$.profile.rails");
  for (const [index, railValue] of rails.entries()) {
    const railPath = `$.profile.rails[${index.toString()}]`;
    const rail = recordValue(railValue, railPath);
    const minimum = requiredInteger(rail.minimumMv, `${railPath}.minimumMv`, 1, 100_000);
    const maximum = requiredInteger(rail.maximumMv, `${railPath}.maximumMv`, 1, 100_000);
    if (minimum > maximum) return snapshotFailure("INPUT_NUMBER_OUT_OF_RANGE", railPath);
    if (!Object.hasOwn(rail, "nominalMv")) {
      return snapshotFailure("INPUT_REQUIRED_NUMBER_MISSING", `${railPath}.nominalMv`);
    }
    if (rail.nominalMv !== null) {
      const nominal = requiredInteger(rail.nominalMv, `${railPath}.nominalMv`, 1, 100_000);
      if (nominal < minimum || nominal > maximum) {
        return snapshotFailure("INPUT_NUMBER_OUT_OF_RANGE", `${railPath}.nominalMv`);
      }
    }
    requiredInteger(rail.budgetMa, `${railPath}.budgetMa`, 1, 100_000);
  }

  for (const [index, componentValue] of arrayValue(profile.components, "$.profile.components").entries()) {
    const componentPath = `$.profile.components[${index.toString()}]`;
    const component = recordValue(componentValue, componentPath);
    requiredInteger(component.quantity, `${componentPath}.quantity`, 1, 1_000);
    const datasheet = recordValue(component.datasheet, `${componentPath}.datasheet`);
    if (datasheet.identity !== undefined) {
      const identity = recordValue(datasheet.identity, `${componentPath}.datasheet.identity`);
      requiredInteger(identity.size, `${componentPath}.datasheet.identity.size`, 1, 16_777_216);
    }
    for (const [circuitIndex, circuitValue] of arrayValue(
      component.referenceCircuits,
      `${componentPath}.referenceCircuits`
    ).entries()) {
      const circuitPath = `${componentPath}.referenceCircuits[${circuitIndex.toString()}]`;
      const circuit = recordValue(circuitValue, circuitPath);
      const sourceIdentity = recordValue(circuit.sourceIdentity, `${circuitPath}.sourceIdentity`);
      requiredInteger(sourceIdentity.size, `${circuitPath}.sourceIdentity.size`, 1, 16_777_216);
      const locator = recordValue(circuit.pageLocator, `${circuitPath}.pageLocator`);
      for (const [pageIndex, page] of arrayValue(locator.printedPages, `${circuitPath}.pageLocator.printedPages`).entries()) {
        requiredInteger(page, `${circuitPath}.pageLocator.printedPages[${pageIndex.toString()}]`, 1, 100_000);
      }
      for (const [pageIndex, page] of arrayValue(locator.pdfPageIndexes, `${circuitPath}.pageLocator.pdfPageIndexes`).entries()) {
        requiredInteger(page, `${circuitPath}.pageLocator.pdfPageIndexes[${pageIndex.toString()}]`, 0, 100_000);
      }
    }
  }
  for (const [index, pinValue] of arrayValue(profile.pins, "$.profile.pins").entries()) {
    const pin = recordValue(pinValue, `$.profile.pins[${index.toString()}]`);
    requiredInteger(pin.physicalPin, `$.profile.pins[${index.toString()}].physicalPin`, 1, 10_000);
  }
  for (const [index, resourceValue] of arrayValue(profile.resources, "$.profile.resources").entries()) {
    const resource = recordValue(resourceValue, `$.profile.resources[${index.toString()}]`);
    requiredInteger(resource.priority, `$.profile.resources[${index.toString()}].priority`, 0, 255);
  }

  const requirements = recordValue(request.requirements, "$.requirements");
  const sourcePrompt = recordValue(requirements.sourcePrompt, "$.requirements.sourcePrompt");
  requiredInteger(sourcePrompt.size, "$.requirements.sourcePrompt.size", 1, 16_777_216);
  for (const [requirementIndex, requirementValue] of arrayValue(
    requirements.requirements,
    "$.requirements.requirements"
  ).entries()) {
    const requirementPath = `$.requirements.requirements[${requirementIndex.toString()}]`;
    const requirement = recordValue(requirementValue, requirementPath);
    for (const [spanIndex, spanValue] of arrayValue(
      requirement.sourceSpans,
      `${requirementPath}.sourceSpans`
    ).entries()) {
      const spanPath = `${requirementPath}.sourceSpans[${spanIndex.toString()}]`;
      const span = recordValue(spanValue, spanPath);
      const start = requiredInteger(span.start, `${spanPath}.start`, 0, 10_000_000);
      const end = requiredInteger(span.end, `${spanPath}.end`, 0, 10_000_000);
      if (start > end) return snapshotFailure("INPUT_NUMBER_OUT_OF_RANGE", spanPath);
    }
  }
  for (const [index, identityValue] of arrayValue(
    request.upstreamArtifactIdentities,
    "$.upstreamArtifactIdentities"
  ).entries()) {
    const identity = recordValue(identityValue, `$.upstreamArtifactIdentities[${index.toString()}]`);
    requiredInteger(identity.size, `$.upstreamArtifactIdentities[${index.toString()}].size`, 1, 16_777_216);
  }
};

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string
): void => {
  const actual = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const requiredSorted = [...required].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const allowed = new Set([...required, ...optional]);
  const missing = requiredSorted.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) return snapshotFailure("INPUT_STRUCTURE_INVALID", `${path}.${missing}`);
  const unknown = actual.find((key) => !allowed.has(key));
  if (unknown !== undefined) return snapshotFailure("INPUT_UNKNOWN_FIELD", `${path}.${unknown}`);
};

const requiredString = (value: unknown, path: string): string =>
  typeof value === "string" ? value : snapshotFailure("INPUT_STRUCTURE_INVALID", path);

const stringArray = (value: unknown, path: string): readonly string[] => {
  const array = arrayValue(value, path);
  return array.map((entry, index) => requiredString(entry, `${path}[${index.toString()}]`));
};

const validateSimulationRequestContract = (
  request: Record<string, unknown>
): SimulationRequest => {
  exactKeys(
    request,
    [
      "schemaVersion",
      "expectedSourceRevisionDigest",
      "profile",
      "requirements",
      "upstreamArtifactIdentities"
    ],
    [],
    "$"
  );
  if (request.schemaVersion !== "evleda.simulation-request.v1") {
    return snapshotFailure("INPUT_STRUCTURE_INVALID", "$.schemaVersion");
  }
  const sourceRevisionDigest = requiredString(
    request.expectedSourceRevisionDigest,
    "$.expectedSourceRevisionDigest"
  );
  if (!/^[0-9a-f]{64}$/u.test(sourceRevisionDigest)) {
    return snapshotFailure("INPUT_STRUCTURE_INVALID", "$.expectedSourceRevisionDigest");
  }

  const profile = recordValue(request.profile, "$.profile");
  exactKeys(
    profile,
    [
      "schemaVersion",
      "profileId",
      "boardRevision",
      "lifecycle",
      "inputVoltageMv",
      "motor",
      "stackup",
      "interfaceSelections",
      "parameterValidation",
      "components",
      "rails",
      "pins",
      "resources",
      "protocols",
      "layoutConstraints",
      "exclusions"
    ],
    [],
    "$.profile"
  );
  if (
    profile.schemaVersion !== "evleda.reference-controller.v0" ||
    profile.profileId !== "robotics-controller-v0" ||
    profile.lifecycle !== "candidate"
  ) {
    return snapshotFailure("INPUT_STRUCTURE_INVALID", "$.profile");
  }
  const boardRevision = requiredString(profile.boardRevision, "$.profile.boardRevision");
  const inputVoltage = recordValue(profile.inputVoltageMv, "$.profile.inputVoltageMv");
  exactKeys(inputVoltage, ["minimum", "maximum"], [], "$.profile.inputVoltageMv");
  const motor = recordValue(profile.motor, "$.profile.motor");
  exactKeys(
    motor,
    ["channels", "rmsCurrentMaPerChannel", "currentChopMaPerChannel"],
    [],
    "$.profile.motor"
  );
  const stackup = recordValue(profile.stackup, "$.profile.stackup");
  exactKeys(stackup, ["layerCount", "layers"], [], "$.profile.stackup");
  const layers = stringArray(stackup.layers, "$.profile.stackup.layers");
  const interfaceSelections = stringArray(
    profile.interfaceSelections,
    "$.profile.interfaceSelections"
  );
  const validInterfaces = new Set(["USB", "CAN", "UART", "I2C", "SPI", "SWD", "ENCODER"]);
  if (
    new Set(interfaceSelections).size !== interfaceSelections.length ||
    interfaceSelections.some((entry) => !validInterfaces.has(entry))
  ) {
    return snapshotFailure("INPUT_STRUCTURE_INVALID", "$.profile.interfaceSelections");
  }
  const parameterValidation = recordValue(
    profile.parameterValidation,
    "$.profile.parameterValidation"
  );
  exactKeys(
    parameterValidation,
    ["supportStatus", "unsupportedReasons"],
    [],
    "$.profile.parameterValidation"
  );
  if (
    parameterValidation.supportStatus !== "supported" &&
    parameterValidation.supportStatus !== "unsupported"
  ) {
    return snapshotFailure("INPUT_STRUCTURE_INVALID", "$.profile.parameterValidation.supportStatus");
  }
  stringArray(
    parameterValidation.unsupportedReasons,
    "$.profile.parameterValidation.unsupportedReasons"
  );
  const expectedProfile = createReferenceControllerProfile({
    boardRevision,
    inputVoltageMv: {
      minimum: inputVoltage.minimum as number,
      maximum: inputVoltage.maximum as number
    },
    motor: {
      channels: motor.channels as number,
      rmsCurrentMaPerChannel: motor.rmsCurrentMaPerChannel as number,
      currentChopMaPerChannel: motor.currentChopMaPerChannel as number
    },
    stackup: { layerCount: stackup.layerCount as number, layers },
    interfaceSelections: interfaceSelections as ReferenceControllerProfile["interfaceSelections"]
  });
  if (!Array.isArray(profile.rails) || profile.rails.length !== expectedProfile.rails.length) {
    return snapshotFailure("INPUT_STRUCTURE_INVALID", "$.profile.rails");
  }
  const normalizedProfile = structuredClone(profile) as Record<string, unknown> & {
    rails: { budgetMa: number }[];
  };
  for (const [index, expectedRail] of expectedProfile.rails.entries()) {
    const actualRail = recordValue(profile.rails[index], `$.profile.rails[${index.toString()}]`);
    if (actualRail.name !== expectedRail.name) {
      return snapshotFailure("INPUT_STRUCTURE_INVALID", `$.profile.rails[${index.toString()}].name`);
    }
    normalizedProfile.rails[index]!.budgetMa = expectedRail.budgetMa;
  }
  if (canonicalJson(normalizedProfile) !== canonicalJson(expectedProfile)) {
    return snapshotFailure("INPUT_STRUCTURE_INVALID", "$.profile");
  }

  const requirementsResult = requirementsDocumentSchema.safeParse(request.requirements);
  if (!requirementsResult.success) {
    return snapshotFailure("INPUT_STRUCTURE_INVALID", "$.requirements");
  }
  const requirements = requirementsResult.data;
  const {
    identity: requirementsIdentity,
    approvalId: _approvalId,
    ...requirementsIdentityPayload
  } = requirements;
  const expectedRequirementsIdentity = canonicalIdentity(
    requirementsIdentityPayload,
    "evleda.requirements.v1"
  );
  if (canonicalJson(requirementsIdentity) !== canonicalJson(expectedRequirementsIdentity)) {
    return snapshotFailure("INPUT_IDENTITY_MISMATCH", "$.requirements.identity");
  }

  const upstreamValues = arrayValue(
    request.upstreamArtifactIdentities,
    "$.upstreamArtifactIdentities"
  );
  if (upstreamValues.length > 4_096) {
    return snapshotFailure("INPUT_SIZE_EXCEEDED", "$.upstreamArtifactIdentities");
  }
  const upstreamArtifactIdentities: ContentIdentity[] = [];
  for (const [index, identityValue] of upstreamValues.entries()) {
    const parsed = contentIdentitySchema.safeParse(identityValue);
    if (!parsed.success) {
      return snapshotFailure(
        "INPUT_STRUCTURE_INVALID",
        `$.upstreamArtifactIdentities[${index.toString()}]`
      );
    }
    upstreamArtifactIdentities.push(parsed.data);
  }
  if (
    new Set(upstreamArtifactIdentities.map((identity) => canonicalJson(identity))).size !==
    upstreamArtifactIdentities.length
  ) {
    return snapshotFailure("INPUT_STRUCTURE_INVALID", "$.upstreamArtifactIdentities");
  }
  return {
    schemaVersion: "evleda.simulation-request.v1",
    expectedSourceRevisionDigest: sourceRevisionDigest,
    profile: profile as unknown as ReferenceControllerProfile,
    requirements: requirements as unknown as SimulationRequest["requirements"],
    upstreamArtifactIdentities
  };
};

const snapshotSimulationRequest = (request: unknown): SimulationInputSnapshot => {
  const sourceRevisionDigest = safeSourceRevisionDigest(request);
  try {
    const snapshot = snapshotPlainSimulationData(request);
    const record = recordValue(snapshot, "$");
    validateSimulationNumericDomain(record);
    return { status: "valid", request: validateSimulationRequestContract(record) };
  } catch (error) {
    return {
      status: "unsupported",
      sourceRevisionDigest,
      issue: error instanceof SimulationInputSnapshotError
        ? error.issue
        : { code: "INPUT_INSPECTION_FAILED", path: "$" }
    };
  }
};

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const floorRatio = (numeratorFactors: readonly number[], denominatorFactors: readonly number[]): number => {
  const numerator = numeratorFactors.reduce((value, factor) => value * BigInt(factor), 1n);
  const denominator = denominatorFactors.reduce((value, factor) => value * BigInt(factor), 1n);
  if (denominator <= 0n || numerator < 0n) {
    throw new RangeError("Fixed-point ratio requires a non-negative numerator and positive denominator.");
  }
  const result = numerator / denominator;
  const asNumber = Number(result);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError("Fixed-point result exceeds the safe integer range.");
  }
  return asNumber;
};

const ceilRatio = (numeratorFactors: readonly number[], denominatorFactors: readonly number[]): number => {
  const numerator = numeratorFactors.reduce((value, factor) => value * BigInt(factor), 1n);
  const denominator = denominatorFactors.reduce((value, factor) => value * BigInt(factor), 1n);
  if (denominator <= 0n || numerator < 0n) {
    throw new RangeError("Fixed-point ratio requires a non-negative numerator and positive denominator.");
  }
  const result = (numerator + denominator - 1n) / denominator;
  const asNumber = Number(result);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError("Fixed-point result exceeds the safe integer range.");
  }
  return asNumber;
};

const roundRatio = (numeratorFactors: readonly number[], denominatorFactors: readonly number[]): number => {
  const numerator = numeratorFactors.reduce((value, factor) => value * BigInt(factor), 1n);
  const denominator = denominatorFactors.reduce((value, factor) => value * BigInt(factor), 1n);
  if (denominator <= 0n || numerator < 0n) {
    throw new RangeError("Fixed-point ratio requires a non-negative numerator and positive denominator.");
  }
  const result = (numerator * 2n + denominator) / (denominator * 2n);
  const asNumber = Number(result);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError("Fixed-point result exceeds the safe integer range.");
  }
  return asNumber;
};

const rail = (
  profile: ReferenceControllerProfile,
  name: string
): PowerRailContract | undefined => profile.rails.find((candidate) => candidate.name === name);

const profileBinding = (
  request: SimulationRequest,
  extra: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => ({
  requestSchemaVersion: request.schemaVersion,
  profileSchemaVersion: request.profile.schemaVersion,
  profileId: request.profile.profileId,
  boardRevision: request.profile.boardRevision,
  lifecycle: request.profile.lifecycle,
  inputVoltageMv: request.profile.inputVoltageMv,
  motor: request.profile.motor,
  stackup: request.profile.stackup,
  interfaceSelections: request.profile.interfaceSelections,
  parameterValidation: request.profile.parameterValidation,
  requirementsIdentity: request.requirements.identity,
  requirementsConstraints: request.requirements.constraints,
  ...extra
});

const model = (
  request: SimulationRequest,
  coverageItem: SimulationCoverageItem,
  options: {
    readonly binding: Readonly<Record<string, unknown>>;
    readonly equations: readonly ModelEquation[];
    readonly parameters: readonly ModelParameter[];
    readonly sources: readonly SourceLocation[];
    readonly tolerances: Readonly<Record<string, unknown>>;
    readonly ambientCopperDuty: Readonly<Record<string, unknown>>;
    readonly unsupportedSubcoverage: readonly string[];
    readonly evidenceInputs?: readonly ReferenceSimulationEvidenceInput[];
  }
): ReferenceSimulationModel => ({
  schemaVersion: REFERENCE_SIMULATION_MODEL_SCHEMA,
  modelVersion: REFERENCE_SIMULATION_MODEL_VERSION,
  coverageItem,
  criticScope:
    "Deterministic analytic critic evidence for the pinned EvlEDA v0 candidate only; it is not circuit simulation, physical qualification, safety proof, or release authorization.",
  profileBinding: profileBinding(request, options.binding),
  equations: options.equations,
  parameters: options.parameters,
  sources: options.sources,
  toleranceAssumptions: options.tolerances,
  ambientCopperAndDutyAssumptions: options.ambientCopperDuty,
  unsupportedSubcoverage: options.unsupportedSubcoverage,
  evidenceInputs: options.evidenceInputs ?? []
});

const commonChecks = (request: SimulationRequest): readonly ReferenceSimulationCheck[] => {
  const checks: ReferenceSimulationCheck[] = [];
  const profile = request.profile;
  checks.push(
    check(
      "request_schema",
      request.schemaVersion === "evleda.simulation-request.v1" ? "pass" : "unsupported",
      { requestSchemaVersion: request.schemaVersion },
      "Request schema is evleda.simulation-request.v1.",
      "No compatibility inference is made for another request schema."
    ),
    check(
      "source_revision_digest",
      /^[0-9a-f]{64}$/u.test(request.expectedSourceRevisionDigest) ? "pass" : "unsupported",
      { sourceRevisionDigest: request.expectedSourceRevisionDigest },
      "Expected source revision is a lowercase SHA-256 digest.",
      "Every emitted report copies this exact digest."
    ),
    check(
      "pinned_profile",
      profile.schemaVersion === "evleda.reference-controller.v0" &&
        profile.profileId === "robotics-controller-v0" &&
        profile.boardRevision === "EVL-RC-G0-REV-A" &&
        profile.lifecycle === "candidate"
        ? "pass"
        : "unsupported",
      {
        profileSchemaVersion: profile.schemaVersion,
        profileId: profile.profileId,
        boardRevision: profile.boardRevision,
        lifecycle: profile.lifecycle
      },
      "Only the pinned robotics-controller-v0 EVL-RC-G0-REV-A candidate is modeled.",
      "A profile, revision, or lifecycle change requires a new reviewed model."
    ),
    check(
      "profile_parameter_support",
      profile.parameterValidation.supportStatus === "supported" &&
        profile.parameterValidation.unsupportedReasons.length === 0
        ? "pass"
        : "unsupported",
      {
        supportStatus: profile.parameterValidation.supportStatus,
        unsupportedReasons: profile.parameterValidation.unsupportedReasons.join(",")
      },
      "The profile parameter validator reports supported with no reasons.",
      "Unsupported generator parameters cannot be rescued by this backend."
    )
  );

  const inputIsNumeric =
    integer(profile.inputVoltageMv.minimum) && integer(profile.inputVoltageMv.maximum);
  checks.push(
    check(
      "v0_input_envelope",
      inputIsNumeric &&
        profile.inputVoltageMv.minimum >= 7_000 &&
        profile.inputVoltageMv.maximum <= 16_800 &&
        profile.inputVoltageMv.minimum <= profile.inputVoltageMv.maximum
        ? "pass"
        : "unsupported",
      {
        minimumMv: inputIsNumeric ? profile.inputVoltageMv.minimum : null,
        maximumMv: inputIsNumeric ? profile.inputVoltageMv.maximum : null
      },
      "Input endpoints are safe integers ordered inside the pinned 7000-16800 mV model envelope.",
      "No interpolation or extrapolation is performed outside the pinned reference envelope."
    )
  );

  const motorNumeric =
    integer(profile.motor.channels) &&
    integer(profile.motor.rmsCurrentMaPerChannel) &&
    integer(profile.motor.currentChopMaPerChannel);
  checks.push(
    check(
      "v0_motor_envelope",
      motorNumeric &&
        profile.motor.channels === 2 &&
        profile.motor.rmsCurrentMaPerChannel > 0 &&
        profile.motor.rmsCurrentMaPerChannel <= 500 &&
        profile.motor.currentChopMaPerChannel === 1_000
        ? "pass"
        : "unsupported",
      {
        channels: motorNumeric ? profile.motor.channels : null,
        rmsCurrentMaPerChannel: motorNumeric ? profile.motor.rmsCurrentMaPerChannel : null,
        currentChopMaPerChannel: motorNumeric ? profile.motor.currentChopMaPerChannel : null
      },
      "Two channels, no more than 500 mA RMS/channel, and the fixed 1000 mA trip target.",
      "Changed channel/current parameters require a new source-bound circuit model."
    )
  );

  checks.push(
    check(
      "stackup_and_interfaces",
      profile.stackup.layerCount === 6 &&
        sameStrings(profile.stackup.layers, EXPECTED_LAYERS) &&
        sameStrings(profile.interfaceSelections, EXPECTED_INTERFACES)
        ? "pass"
        : "unsupported",
      {
        layerCount: profile.stackup.layerCount,
        layers: profile.stackup.layers.join(","),
        interfaces: profile.interfaceSelections.join(",")
      },
      "The exact six-layer 1+4+1 HDI stackup and complete ordered v0 interface set are present.",
      "Thermal and reset assumptions are not portable to another stackup or interface set."
    )
  );

  const seenKeys = new Set<ReferenceComponentKey>();
  let componentsMatch = profile.components.length === Object.keys(EXPECTED_COMPONENTS).length;
  for (const component of profile.components) {
    const expected = EXPECTED_COMPONENTS[component.key];
    if (
      seenKeys.has(component.key) ||
      component.manufacturer !== expected.manufacturer ||
      component.partNumber !== expected.partNumber ||
      component.package !== expected.package ||
      component.footprint !== expected.footprint ||
      component.datasheet.url !== expected.datasheetUrl ||
      component.datasheet.identity?.algorithm !== "sha256" ||
      component.datasheet.identity.size !== expected.datasheetSize ||
      component.datasheet.identity.digest !== expected.datasheetDigest
    ) {
      componentsMatch = false;
    }
    seenKeys.add(component.key);
  }
  componentsMatch =
    componentsMatch &&
    (Object.keys(EXPECTED_COMPONENTS) as ReferenceComponentKey[]).every((key) => seenKeys.has(key));
  checks.push(
    check(
      "component_and_pdf_identities",
      componentsMatch ? "pass" : "unsupported",
      {
        componentCount: profile.components.length,
        uniqueComponentCount: seenKeys.size,
        exactPinnedIdentities: componentsMatch
      },
      "All eight exact v0 manufacturers, MPNs, packages, footprints, datasheet URLs, and manufacturer PDF byte identities match.",
      "A part, package, footprint, source URL, or source-byte change invalidates the model even when the marketing family is unchanged."
    )
  );

  const constraints = request.requirements.constraints;
  const expectedConstraints = {
    input_voltage_min_mv: String(profile.inputVoltageMv.minimum),
    input_voltage_max_mv: String(profile.inputVoltageMv.maximum),
    motor_channels: String(profile.motor.channels),
    motor_current_rms_ma: String(profile.motor.rmsCurrentMaPerChannel)
  };
  const constraintsMatch = Object.entries(expectedConstraints).every(
    ([key, value]) => constraints[key] === value
  );
  checks.push(
    check(
      "requirements_profile_numeric_binding",
      constraintsMatch ? "pass" : "unsupported",
      {
        constraintsMatch,
        inputVoltageMinimum: constraints.input_voltage_min_mv ?? null,
        inputVoltageMaximum: constraints.input_voltage_max_mv ?? null,
        motorChannels: constraints.motor_channels ?? null,
        motorCurrentRmsMa: constraints.motor_current_rms_ma ?? null
      },
      "Requirements carry all four numeric v0 constraints and exactly match the profile.",
      "Missing or conflicting numeric requirements are unsupported, never defaulted by the critic."
    )
  );

  const hasBlockingAssumption = request.requirements.unresolvedAssumptions.some(
    (assumption) => assumption.severity === "blocking"
  );
  checks.push(
    check(
      "no_blocking_requirement_assumption",
      hasBlockingAssumption ? "unsupported" : "pass",
      { hasBlockingAssumption },
      "Requirements contain no unresolved blocking assumption.",
      "This backend does not waive or reinterpret requirement blockers."
    )
  );
  return checks;
};

const powerTreeModel = (request: SimulationRequest): ModelBuild => {
  const five = rail(request.profile, "5V0");
  const three = rail(request.profile, "3V3");
  const sensor = rail(request.profile, "5V_SENSOR");
  const vbat = rail(request.profile, "VBAT_PROTECTED");
  const completeRails = five !== undefined && three !== undefined && sensor !== undefined && vbat !== undefined;

  const buckNominalMv = five?.nominalMv ?? null;
  const ldoNominalMv = three?.nominalMv ?? null;
  const buckMinimumMv =
    buckNominalMv === null ? null : floorRatio([buckNominalMv, PPM - 15_000], [PPM]);
  const buckMaximumMv =
    buckNominalMv === null ? null : ceilRatio([buckNominalMv, PPM + 15_000], [PPM]);
  const ldoMinimumMv =
    ldoNominalMv === null
      ? null
      : floorRatio([ldoNominalMv, PPM - 15_000], [PPM]) - 32;
  const ldoMaximumMv =
    ldoNominalMv === null
      ? null
      : ceilRatio([ldoNominalMv, PPM + 15_000], [PPM]) + 32;
  const sensorDropMaximumMv =
    sensor === undefined ? null : ceilRatio([sensor.budgetMa, 135], [1_000]);
  const sensorMinimumMv =
    buckMinimumMv === null || sensorDropMaximumMv === null
      ? null
      : buckMinimumMv - sensorDropMaximumMv;
  const sensorMaximumMv = buckMaximumMv;
  const buckOperatingLoadUa =
    three === undefined || sensor === undefined
      ? null
      : three.budgetMa * 1_000 + 40 + sensor.budgetMa * 1_000 + 140;

  const checks: ReferenceSimulationCheck[] = [...commonChecks(request)];
  checks.push(
    check(
      "required_rail_contracts",
      completeRails ? "pass" : "unsupported",
      {
        hasVbat: vbat !== undefined,
        has5v0: five !== undefined,
        has3v3: three !== undefined,
        has5vSensor: sensor !== undefined
      },
      "VBAT_PROTECTED, 5V0, 3V3, and 5V_SENSOR contracts all exist.",
      "A missing rail leaves the operating point undefined."
    )
  );

  const numericRails = [five, three, sensor, vbat].every(
    (candidate) =>
      candidate !== undefined &&
      integer(candidate.minimumMv) &&
      integer(candidate.maximumMv) &&
      integer(candidate.budgetMa) &&
      candidate.minimumMv <= candidate.maximumMv &&
      candidate.budgetMa > 0
  );
  checks.push(
    check(
      "numeric_rail_limits",
      numericRails ? "pass" : "unsupported",
      { numericRailLimits: numericRails },
      "Every modeled rail has ordered safe-integer voltage limits and a positive safe-integer current budget.",
      "Missing, fractional, non-finite, or non-positive limits cannot pass."
    )
  );

  const railBandsPass =
    completeRails &&
    buckMinimumMv !== null &&
    buckMaximumMv !== null &&
    ldoMinimumMv !== null &&
    ldoMaximumMv !== null &&
    sensorMinimumMv !== null &&
    sensorMaximumMv !== null &&
    buckMinimumMv >= five.minimumMv &&
    buckMaximumMv <= five.maximumMv &&
    ldoMinimumMv >= three.minimumMv &&
    ldoMaximumMv <= three.maximumMv &&
    sensorMinimumMv >= sensor.minimumMv &&
    sensorMaximumMv <= sensor.maximumMv;
  checks.push(
    check(
      "static_dc_rail_bands",
      completeRails && numericRails ? (railBandsPass ? "pass" : "fail") : "unsupported",
      {
        buckMinimumMv,
        buckMaximumMv,
        ldoMinimumMv,
        ldoMaximumMv,
        sensorMinimumMv,
        sensorMaximumMv
      },
      "Outward-rounded modeled DC endpoints remain inside every declared rail band.",
      "LMR51420 FPWM and TLV755P accuracy limits plus TPS2553 switch drop are applied without rounding inward."
    )
  );

  const sourceRangesPass =
    completeRails &&
    request.profile.inputVoltageMv.minimum >= 4_500 &&
    request.profile.inputVoltageMv.maximum <= 36_000 &&
    request.profile.inputVoltageMv.maximum <= 37_000 &&
    buckMaximumMv !== null &&
    buckMinimumMv !== null &&
    ldoNominalMv !== null &&
    buckMaximumMv <= 5_500 &&
    buckMinimumMv >= 2_500 &&
    buckMinimumMv >= ldoNominalMv + 238;
  checks.push(
    check(
      "device_operating_ranges",
      completeRails ? (sourceRangesPass ? "pass" : "fail") : "unsupported",
      {
        batteryMinimumMv: request.profile.inputVoltageMv.minimum,
        batteryMaximumMv: request.profile.inputVoltageMv.maximum,
        generated5vMinimumMv: buckMinimumMv,
        generated5vMaximumMv: buckMaximumMv,
        ldoNominalMv,
        ldoDropoutMaximumMv: 238,
        ldoInputHeadroomMv:
          buckMinimumMv === null || ldoNominalMv === null
            ? null
            : buckMinimumMv - ldoNominalMv
      },
      "Battery and derived rail endpoints remain inside LMR51420, DRV8874, TLV755P, and TPS2553 operating ranges.",
      "The narrowest applicable datasheet limits are used."
    )
  );

  const loadRangesPass =
    completeRails &&
    buckOperatingLoadUa !== null &&
    buckOperatingLoadUa <= 2_000_000 &&
    five.budgetMa <= 2_000 &&
    three.budgetMa <= 500 &&
    sensor.budgetMa <= 1_200 &&
    three.budgetMa <= 560;
  checks.push(
    check(
      "source_current_capabilities",
      completeRails ? (loadRangesPass ? "pass" : "fail") : "unsupported",
      {
        buckOperatingLoadUa,
        buckRatedOutputUa: 2_000_000,
        ldoBudgetMa: three?.budgetMa ?? null,
        ldoRatedOutputMa: 500,
        ldoMinimumCurrentLimitMa: 560,
        sensorBudgetMa: sensor?.budgetMa ?? null,
        sensorContinuousLimitMa: 1_200
      },
      "Declared downstream operating loads do not exceed sourced regulator/switch current capabilities.",
      "This is a static reservation check and is not a startup, short-circuit, or transient-current proof."
    )
  );

  const built = model(request, "power_tree_operating_points", {
    binding: {
      rails: request.profile.rails,
      calculatedOperatingPointsMv: {
        fiveV0: { minimum: buckMinimumMv, maximum: buckMaximumMv },
        threeV3: { minimum: ldoMinimumMv, maximum: ldoMaximumMv },
        fiveVSensor: { minimum: sensorMinimumMv, maximum: sensorMaximumMv }
      },
      buckOperatingLoadUa
    },
    equations: [
      equation(
        "regulated_output_bounds",
        "VBUCK_MIN/MAX=VNOM*(1+/-accuracy); VLDO_MIN/MAX=VNOM*(1+/-accuracy)+/-(full-load regulation+line regulation)",
        "Integer mV and ppm with outward rounding; the LDO adds the full 500 mA DBV load-regulation magnitude and line-regulation magnitude in the adverse direction.",
        [SOURCES.lmrElectrical.id, SOURCES.tlvElectrical.id]
      ),
      equation(
        "sensor_switch_drop",
        "V5V_SENSOR_MIN=V5V0_MIN-ceil(I_SENSOR_MAX*RDS_ON_MAX)",
        "Integer mA and milliohm; product is rounded upward to mV.",
        [SOURCES.tpsElectrical.id]
      ),
      equation(
        "buck_load_reservation",
        "I5V0=I3V3_BUDGET+IGND_LDO_MAX+I5V_SENSOR_BUDGET+IIN_SWITCH_MAX",
        "Integer microamp sum; no efficiency or transient inference.",
        [SOURCES.tlvElectrical.id, SOURCES.tpsElectrical.id]
      )
    ],
    parameters: [
      parameter("lmr_input_minimum", 4_500, "mV", "datasheet_limit", [SOURCES.lmrElectrical.id], "Operating input minimum."),
      parameter("lmr_input_maximum", 36_000, "mV", "datasheet_limit", [SOURCES.lmrElectrical.id], "Operating input maximum."),
      parameter("lmr_output_current_maximum", 2_000, "mA", "datasheet_limit", [SOURCES.lmrElectrical.id], "Continuous DC output capability."),
      parameter("lmr_fpwm_output_regulation_tolerance", 15_000, "ppm", "datasheet_limit", [SOURCES.lmrElectrical.id], "-1.5% to +1.5% over the stated system-characteristic conditions."),
      parameter("lmr_switching_frequency_nominal", 500_000, "Hz", "datasheet_typical", [SOURCES.lmrVariants.id, SOURCES.lmrElectrical.id], "XF orderable is the 500-kHz FPWM adjustable variant."),
      parameter("tlv_output_accuracy_tolerance", 15_000, "ppm", "datasheet_limit", [SOURCES.tlvElectrical.id], "Full -40 C to 125 C VOUT >= 1 V accuracy limit."),
      parameter("tlv_dbv_load_regulation_full_500ma", 30, "mV", "datasheet_limit", [SOURCES.tlvElectrical.id], "0.060 V/A times the complete 500 mA rated range, conservatively charged rather than only the 400 mA profile budget."),
      parameter("tlv_line_regulation", 2, "mV", "datasheet_limit", [SOURCES.tlvElectrical.id], "Full stated input-range line-regulation magnitude."),
      parameter("tlv_dropout_maximum_at_500ma", 238, "mV", "datasheet_limit", [SOURCES.tlvElectrical.id], "Conservative 3.3-V-class full-temperature value used for input headroom."),
      parameter("tlv_output_current_rating", 500, "mA", "datasheet_limit", [SOURCES.tlvElectrical.id], "Rated source current."),
      parameter("tlv_current_limit_minimum", 560, "mA", "datasheet_limit", [SOURCES.tlvElectrical.id], "Minimum current limit for 1.5 V < VOUT <= 4.5 V."),
      parameter("tlv_ground_current_maximum_no_load", 40, "uA", "datasheet_limit", [SOURCES.tlvElectrical.id], "No-load full-temperature limit; load-dependent ground current is outside this DC bound."),
      parameter("tps_rds_on_maximum", 135, "milliohm", "datasheet_limit", [SOURCES.tpsElectrical.id], "DBV package over -40 C to 125 C."),
      parameter("tps_continuous_output_current", 1_200, "mA", "datasheet_limit", [SOURCES.tpsElectrical.id], "Maximum over -40 C to 125 C."),
      parameter("tps_supply_current_enabled_maximum", 140, "uA", "datasheet_limit", [SOURCES.tpsElectrical.id], "No-load enabled supply current maximum."),
      parameter("drv_input_minimum", 4_500, "mV", "datasheet_limit", [SOURCES.drvElectrical.id], "DRV8874 electrical-characteristic operating minimum."),
      parameter("drv_input_maximum", 37_000, "mV", "datasheet_limit", [SOURCES.drvElectrical.id], "DRV8874 electrical-characteristic operating maximum.")
    ],
    sources: [
      SOURCES.lmrVariants,
      SOURCES.lmrElectrical,
      SOURCES.lmrApplication,
      SOURCES.tlvElectrical,
      SOURCES.tlvModes,
      SOURCES.tpsElectrical,
      SOURCES.drvElectrical
    ],
    tolerances: {
      rounding: "All endpoint calculations round outward in integer fixed-point units.",
      outputTolerancePpm: 15_000,
      capacitorTolerance: "Not modeled; static DC bounds only.",
      loadTransientTolerance: "Not modeled."
    },
    ambientCopperDuty: {
      ambient: "Datasheet regulation ranges only; no board thermal claim is made in this report.",
      copper: "Not used by the static DC equations.",
      duty: "Steady DC operating point only."
    },
    unsupportedSubcoverage: [
      "Startup and shutdown sequencing waveforms",
      "Input-source impedance, reverse-polarity stage, fuse, and TVS behavior",
      "Buck efficiency and battery-input current",
      "Inductor ripple/saturation and capacitor bias/ESR",
      "Ripple, load-step, hot-plug, EMC, and protection transients",
      "Physical rail measurements"
    ]
  });
  return {
    model: built,
    checks,
    conclusion:
      "Static source-bound DC operating points are inside the v0 rail contracts under the captured assumptions; dynamic power behavior remains unsupported here and requires dedicated analysis and bench evidence."
  };
};

const logicBudgetModel = (request: SimulationRequest): ModelBuild => {
  const five = rail(request.profile, "5V0");
  const three = rail(request.profile, "3V3");
  const requiredRails = five !== undefined && three !== undefined;

  const mcuReservationUa = 100_000;
  const canVccFaultMaximumUa = 130_000;
  const canVioMaximumUa = 300;
  const bufferQuantity = 2;
  const bufferIccMaximumUa = 10;
  const bufferInputsPerDevice = 2;
  const bufferDeltaIccPerInputUa = 500;
  const bufferReservationUa =
    bufferQuantity * (bufferIccMaximumUa + bufferInputsPerDevice * bufferDeltaIccPerInputUa);
  const modeled3v3LoadUa =
    mcuReservationUa + canVccFaultMaximumUa + canVioMaximumUa + bufferReservationUa;

  const ldoGroundCurrentMaximumUa = 40;
  const sensorCurrentLimitMaximumUa = 565_000;
  const sensorSwitchSupplyMaximumUa = 140;
  const modeled5v0LoadUa =
    (three?.budgetMa ?? 0) * 1_000 +
    ldoGroundCurrentMaximumUa +
    sensorCurrentLimitMaximumUa +
    sensorSwitchSupplyMaximumUa;

  const budget3v3Ua = (three?.budgetMa ?? 0) * 1_000;
  const budget5v0Ua = (five?.budgetMa ?? 0) * 1_000;
  const allowed3v3Ua = floorRatio([budget3v3Ua, PPM - HEADROOM_PPM], [PPM]);
  const allowed5v0Ua = floorRatio([budget5v0Ua, PPM - HEADROOM_PPM], [PPM]);
  const headroom3v3Ua = budget3v3Ua - modeled3v3LoadUa;
  const headroom5v0Ua = budget5v0Ua - modeled5v0LoadUa;
  const headroom3v3Ppm =
    budget3v3Ua > 0 ? floorRatio([Math.max(0, headroom3v3Ua), PPM], [budget3v3Ua]) : 0;
  const headroom5v0Ppm =
    budget5v0Ua > 0 ? floorRatio([Math.max(0, headroom5v0Ua), PPM], [budget5v0Ua]) : 0;

  const checks: ReferenceSimulationCheck[] = [...commonChecks(request)];
  checks.push(
    check(
      "required_logic_rails",
      requiredRails ? "pass" : "unsupported",
      { has5v0: five !== undefined, has3v3: three !== undefined },
      "5V0 and 3V3 rail contracts exist.",
      "A missing rail makes its current budget unknown."
    )
  );
  const numericBudgets =
    requiredRails && integer(five.budgetMa) && integer(three.budgetMa) && five.budgetMa > 0 && three.budgetMa > 0;
  checks.push(
    check(
      "numeric_logic_budgets",
      numericBudgets ? "pass" : "unsupported",
      { fiveV0BudgetMa: five?.budgetMa ?? null, threeV3BudgetMa: three?.budgetMa ?? null },
      "Both logic-rail budgets are positive safe integers.",
      "Unknown, non-finite, fractional, or non-positive current limits do not pass."
    )
  );
  checks.push(
    check(
      "three_v3_headroom",
      numericBudgets ? (modeled3v3LoadUa <= allowed3v3Ua ? "pass" : "fail") : "unsupported",
      {
        budgetUa: budget3v3Ua,
        modeledLoadUa: modeled3v3LoadUa,
        allowedLoadWith20PercentHeadroomUa: allowed3v3Ua,
        headroomUa: headroom3v3Ua,
        headroomPpm: headroom3v3Ppm
      },
      "Modeled 3V3 reservations consume no more than 80% of the declared budget.",
      "The MCU reservation is the package supply-current absolute ceiling; CAN includes the sourced bus-fault maximum; buffer inputs use worst listed delta-ICC."
    ),
    check(
      "five_v0_headroom",
      numericBudgets ? (modeled5v0LoadUa <= allowed5v0Ua ? "pass" : "fail") : "unsupported",
      {
        budgetUa: budget5v0Ua,
        modeledLoadUa: modeled5v0LoadUa,
        allowedLoadWith20PercentHeadroomUa: allowed5v0Ua,
        headroomUa: headroom5v0Ua,
        headroomPpm: headroom5v0Ppm
      },
      "Modeled 5V0 reservations consume no more than 80% of the declared budget.",
      "The entire 3V3 budget and the TPS2553 maximum 49.9-kohm current-limit excursion are reserved concurrently."
    )
  );

  const built = model(request, "logic_rail_load_budget", {
    binding: {
      railBudgetsMa: {
        fiveV0: five?.budgetMa ?? null,
        threeV3: three?.budgetMa ?? null
      },
      reservationsUa: {
        threeV3: {
          mcu: mcuReservationUa,
          canVccFault: canVccFaultMaximumUa,
          canVio: canVioMaximumUa,
          encoderBuffers: bufferReservationUa,
          total: modeled3v3LoadUa
        },
        fiveV0: {
          fullThreeV3Budget: budget3v3Ua,
          ldoGround: ldoGroundCurrentMaximumUa,
          sensorCurrentLimitMaximum: sensorCurrentLimitMaximumUa,
          sensorSwitchSupply: sensorSwitchSupplyMaximumUa,
          total: modeled5v0LoadUa
        }
      }
    },
    equations: [
      equation(
        "three_v3_reservation",
        "I3V3=IMCU_RESERVED+ICAN_VCC_FAULT_MAX+ICAN_VIO_MAX+NBUFFER*(ICC_MAX+NINPUT*DELTA_ICC_MAX)",
        "Exact integer microamp addition.",
        [SOURCES.stmCurrent.id, SOURCES.tcanSupply.id, SOURCES.bufferElectrical.id]
      ),
      equation(
        "five_v0_reservation",
        "I5V0=I3V3_BUDGET+IGND_LDO_MAX+ISENSOR_LIMIT_MAX+IIN_SWITCH_MAX",
        "Exact integer microamp addition.",
        [SOURCES.tlvElectrical.id, SOURCES.tpsElectrical.id]
      ),
      equation(
        "headroom",
        "HEADROOM_PPM=floor((IBUDGET-ILOAD)*1000000/IBUDGET)",
        "Integer fixed-point; negative raw headroom is retained in microamps and display ppm clamps at zero.",
        []
      )
    ],
    parameters: [
      parameter("required_headroom", HEADROOM_PPM, "ppm", "model_assumption", [], "20% acceptance from the workflow coverage contract."),
      parameter("stm32_supply_pin_reservation", mcuReservationUa, "uA", "datasheet_limit", [SOURCES.stmCurrent.id], "Absolute maximum current into VDD/VDDA and VDDIO2 used as a deliberately conservative reservation, not a predicted operating draw."),
      parameter("tcan_vcc_bus_fault_maximum", canVccFaultMaximumUa, "uA", "datasheet_limit", [SOURCES.tcanSupply.id], "Normal mode dominant with bus fault."),
      parameter("tcan_vio_normal_maximum", canVioMaximumUa, "uA", "datasheet_limit", [SOURCES.tcanSupply.id], "TCAN3413 dominant-state VIO current maximum."),
      parameter("encoder_buffer_quantity", bufferQuantity, "devices", "profile_contract", [], "Two dual buffers in the pinned v0 profile."),
      parameter("encoder_buffer_icc_maximum", bufferIccMaximumUa, "uA/device", "datasheet_limit", [SOURCES.bufferElectrical.id], "Static ICC maximum."),
      parameter("encoder_buffer_delta_icc_maximum", bufferDeltaIccPerInputUa, "uA/input", "datasheet_limit", [SOURCES.bufferElectrical.id], "Worst listed extra current for an input at VCC-0.6 V."),
      parameter("tlv_ground_current_maximum_no_load", ldoGroundCurrentMaximumUa, "uA", "datasheet_limit", [SOURCES.tlvElectrical.id], "No-load full-temperature maximum."),
      parameter("tps_current_limit_maximum_49k9", sensorCurrentLimitMaximumUa, "uA", "datasheet_limit", [SOURCES.tpsElectrical.id], "Maximum IOS for RILIM=49.9 kohm across -40 C to 125 C."),
      parameter("tps_supply_current_enabled_maximum", sensorSwitchSupplyMaximumUa, "uA", "datasheet_limit", [SOURCES.tpsElectrical.id], "Enabled no-load supply current maximum."),
      parameter("usblc6_vbus_leakage_maximum", 150, "nA", "datasheet_limit", [SOURCES.usbProtection.id], "Captured for completeness; USB VBUS is sense/protection-only and is not charged to 3V3 or 5V0.")
    ],
    sources: [
      SOURCES.stmCurrent,
      SOURCES.tcanSupply,
      SOURCES.bufferElectrical,
      SOURCES.tlvElectrical,
      SOURCES.tpsElectrical,
      SOURCES.usbProtection
    ],
    tolerances: {
      headroomPpm: HEADROOM_PPM,
      canCase: "The 130 mA maximum bus-fault VCC case is reserved concurrently with maximum VIO current.",
      bufferCase: "Both inputs of both devices are charged the maximum listed delta-ICC simultaneously.",
      rounding: "All loads are integer microamps; no fractional load is rounded down."
    },
    ambientCopperDuty: {
      ambient: "Uses datasheet maxima over their stated temperature ranges; no board temperature is inferred.",
      copper: "Not used in current-budget arithmetic.",
      duty: "Reservations are concurrent and continuous for budget purposes."
    },
    unsupportedSubcoverage: [
      "Current for user-attached UART, I2C, SPI, SWD, encoder, or sensor hardware",
      "Dynamic GPIO/output-capacitance current beyond the conservative listed reservations",
      "Real firmware-mode current and regulator efficiency",
      "Cable, connector, and protection-network leakage outside the pinned components"
    ]
  });
  return {
    model: built,
    checks,
    conclusion:
      "The pinned on-board/reserved loads retain at least 20% on both logic rails; the remaining headroom is not an authorization for unspecified external loads."
  };
};

const motorChopModel = (request: SimulationRequest): ModelBuild => {
  const three = rail(request.profile, "3V3");
  const railMinimumUv = (three?.minimumMv ?? 0) * 1_000;
  const railNominalUv = (three?.nominalMv ?? 0) * 1_000;
  const railMaximumUv = (three?.maximumMv ?? 0) * 1_000;

  const dividerTopDeciohm = 32_400;
  const dividerBottomDeciohm = 100_000;
  const dividerTopMinimumDeciohm = floorRatio([dividerTopDeciohm, PPM - ONE_PERCENT_PPM], [PPM]);
  const dividerTopMaximumDeciohm = ceilRatio([dividerTopDeciohm, PPM + ONE_PERCENT_PPM], [PPM]);
  const dividerBottomMinimumDeciohm = floorRatio([dividerBottomDeciohm, PPM - ONE_PERCENT_PPM], [PPM]);
  const dividerBottomMaximumDeciohm = ceilRatio([dividerBottomDeciohm, PPM + ONE_PERCENT_PPM], [PPM]);
  const ipropiDeciohm = 54_900;
  const ipropiMinimumDeciohm = floorRatio([ipropiDeciohm, PPM - ONE_PERCENT_PPM], [PPM]);
  const ipropiMaximumDeciohm = ceilRatio([ipropiDeciohm, PPM + ONE_PERCENT_PPM], [PPM]);
  const aipropiUaPerA = 455;
  const mirrorErrorPpm = 75_000;

  const vrefNominalUv = roundRatio(
    [railNominalUv, dividerBottomDeciohm],
    [dividerTopDeciohm + dividerBottomDeciohm]
  );
  const vrefMinimumUv = floorRatio(
    [railMinimumUv, dividerBottomMinimumDeciohm],
    [dividerTopMaximumDeciohm + dividerBottomMinimumDeciohm]
  );
  const vrefMaximumUv = ceilRatio(
    [railMaximumUv, dividerBottomMaximumDeciohm],
    [dividerTopMinimumDeciohm + dividerBottomMaximumDeciohm]
  );
  const tripNominalUa = roundRatio(
    [vrefNominalUv, 10, PPM],
    [ipropiDeciohm, aipropiUaPerA]
  );
  const tripMinimumUa = floorRatio(
    [vrefMinimumUv, 10, PPM, PPM],
    [ipropiMaximumDeciohm, aipropiUaPerA, PPM + mirrorErrorPpm]
  );
  const tripMaximumUa = ceilRatio(
    [vrefMaximumUv, 10, PPM, PPM],
    [ipropiMinimumDeciohm, aipropiUaPerA, PPM - mirrorErrorPpm]
  );
  const targetUa = request.profile.motor.currentChopMaPerChannel * 1_000;
  const nominalToleranceUa = ceilRatio([targetUa, ONE_PERCENT_PPM], [PPM]);
  const nominalErrorUa = Math.abs(tripNominalUa - targetUa);

  const checks: ReferenceSimulationCheck[] = [...commonChecks(request)];
  const sourceConditions =
    request.profile.inputVoltageMv.minimum >= 5_500 &&
    request.profile.inputVoltageMv.maximum <= 37_000 &&
    three !== undefined &&
    three.nominalMv !== null &&
    integer(three.minimumMv) &&
    integer(three.nominalMv) &&
    integer(three.maximumMv);
  checks.push(
    check(
      "trip_model_source_conditions",
      sourceConditions ? "pass" : "unsupported",
      {
        motorSupplyMinimumMv: request.profile.inputVoltageMv.minimum,
        motorSupplyMaximumMv: request.profile.inputVoltageMv.maximum,
        logicRailMinimumMv: three?.minimumMv ?? null,
        logicRailNominalMv: three?.nominalMv ?? null,
        logicRailMaximumMv: three?.maximumMv ?? null
      },
      "DRV8874 mirror-error conditions (5.5-37 V) apply and the VREF source rail has complete numeric endpoints.",
      "The critic does not extrapolate the AERR table or invent a missing VREF source."
    )
  );
  const thresholdPass =
    sourceConditions &&
    tripMinimumUa <= targetUa &&
    tripMaximumUa >= targetUa &&
    nominalErrorUa <= nominalToleranceUa;
  checks.push(
    check(
      "comparator_trip_threshold",
      sourceConditions ? (thresholdPass ? "pass" : "fail") : "unsupported",
      {
        targetUa,
        nominalUa: tripNominalUa,
        nominalErrorUa,
        allowedNominalErrorUa: nominalToleranceUa,
        toleranceMinimumUa: tripMinimumUa,
        toleranceMaximumUa: tripMaximumUa,
        vrefMinimumUv,
        vrefNominalUv,
        vrefMaximumUv
      },
      "The 1000 mA target lies inside the outward-rounded component-tolerance extrema and nominal error is no larger than the selected 1% resistor class.",
      "The full 7.5% AERR band is used conservatively across the threshold even though the >=1 A row is tighter."
    )
  );

  const built = model(request, "motor_current_chop", {
    binding: {
      logicRail: three ?? null,
      tripTargetMa: request.profile.motor.currentChopMaPerChannel,
      calculated: {
        vrefUv: { minimum: vrefMinimumUv, nominal: vrefNominalUv, maximum: vrefMaximumUv },
        tripUa: { minimum: tripMinimumUa, nominal: tripNominalUa, maximum: tripMaximumUa }
      },
      revisionADivider: {
        upperOhm: 3_240,
        lowerOhm: 10_000,
        tolerancePpm: ONE_PERCENT_PPM
      },
      revisionAIpropiResistor: { ohm: 5_490, tolerancePpm: ONE_PERCENT_PPM }
    },
    equations: [
      equation(
        "vref_divider",
        "VREF=V3V3*RLOWER/(RUPPER+RLOWER)",
        "Resistance is represented in 0.1 ohm and voltage in microvolt; minimum/maximum pair the adverse 1% resistor endpoints and rail endpoints.",
        [SOURCES.drvApplication.id]
      ),
      equation(
        "drv8874_trip",
        "ITRIP=VREF/(RIPROPI*AIPROPI)",
        "Integer microamp result; endpoints pair adverse VREF, RIPROPI, and +/-7.5% mirror-error factors with outward rounding.",
        [SOURCES.drvRegulation.id, SOURCES.drvApplication.id]
      )
    ],
    parameters: [
      parameter("trip_target", targetUa, "uA", "profile_contract", [], "Per-channel profile current-chop target."),
      parameter("aipropi_application_value", aipropiUaPerA, "uA/A", "datasheet_typical", [SOURCES.drvApplication.id], "Table 8 application value used by TI's 1 A worked example."),
      parameter("mirror_error_conservative", mirrorErrorPpm, "ppm", "datasheet_limit", [SOURCES.drvElectrical.id], "Uses the +/-7.5% 0.4 A to <1 A row across the whole near-1-A interval."),
      parameter("ipropi_resistor", 5_490, "ohm", "revision_a_design_value", [SOURCES.drvApplication.id], "Rev-A selected value; TI's worked example is 5.5 kohm."),
      parameter("vref_divider_upper", 3_240, "ohm", "revision_a_design_value", [SOURCES.drvApplication.id], "Rev-A 1% divider value."),
      parameter("vref_divider_lower", 10_000, "ohm", "revision_a_design_value", [SOURCES.drvApplication.id], "Rev-A 1% divider value."),
      parameter("resistor_tolerance", ONE_PERCENT_PPM, "ppm", "revision_a_design_value", [SOURCES.drvApplication.id], "TI identifies 1% as the typical recommendation; Rev A specifies 1% parts."),
      parameter("sense_delay_typical", 1_600, "ns", "datasheet_typical", [SOURCES.drvElectrical.id], "Captured but deliberately excluded from the static comparator-threshold acceptance."),
      parameter("blanking_time_typical", 1_100, "ns", "datasheet_typical", [SOURCES.drvElectrical.id], "Captured but deliberately excluded from the static comparator-threshold acceptance.")
    ],
    sources: [SOURCES.drvElectrical, SOURCES.drvRegulation, SOURCES.drvApplication],
    tolerances: {
      resistorPpm: ONE_PERCENT_PPM,
      currentMirrorErrorPpm: mirrorErrorPpm,
      endpointPairing: "Adverse independent endpoints are paired; no statistical cancellation.",
      rounding: "Minimum rounds down and maximum rounds up."
    },
    ambientCopperDuty: {
      ambient: "Comparator threshold uses the datasheet AERR range over the source conditions; no temperature waveform is inferred.",
      copper: "Not used by the comparator equation.",
      duty: "Static comparator threshold only; PWM timing is not modeled."
    },
    unsupportedSubcoverage: [
      "Motor-current ripple and overshoot",
      "PWM transient and current-decay behavior",
      "Motor winding resistance and inductance",
      "Motor back-EMF and mechanical load",
      "Battery/source impedance and wiring inductance",
      "Current-sense delay/blanking interaction with a real waveform",
      "Guarded-load oscilloscope/current-probe verification"
    ]
  });
  return {
    model: built,
    checks,
    conclusion:
      "The conditional pass is only for the DRV8874 comparator trip-threshold equation and declared component-tolerance extrema; it makes no claim about ripple, overshoot, PWM transients, or any real motor waveform."
  };
};

const motorThermalModel = (request: SimulationRequest): ModelBuild => {
  const motorSupplyMv = request.profile.inputVoltageMv.maximum;
  const rmsCurrentMa = request.profile.motor.rmsCurrentMaPerChannel;
  const activeCurrentMa = 7;
  const switchingFrequencyHz = 20_000;
  const riseTimeNs = 150;
  const fallTimeNs = 150;
  const rdsOnEachMilliohm = 120;
  const rdsTemperatureMultiplierPpm = 1_250_000;
  const thetaJaCPerW = 36;
  const ambientMilliC = 85_000;
  const junctionLimitMilliC = 150_000;

  const supplyPowerUw = motorSupplyMv * activeCurrentMa;
  const risePowerUw = ceilRatio(
    [motorSupplyMv, rmsCurrentMa, riseTimeNs, switchingFrequencyHz],
    [2_000_000_000]
  );
  const fallPowerUw = ceilRatio(
    [motorSupplyMv, rmsCurrentMa, fallTimeNs, switchingFrequencyHz],
    [2_000_000_000]
  );
  const effectiveBridgeResistanceMilliohm = ceilRatio(
    [2, rdsOnEachMilliohm, rdsTemperatureMultiplierPpm],
    [PPM]
  );
  const conductionPowerUw = ceilRatio(
    [rmsCurrentMa, rmsCurrentMa, effectiveBridgeResistanceMilliohm],
    [1_000]
  );
  const totalPowerUw = supplyPowerUw + risePowerUw + fallPowerUw + conductionPowerUw;
  const riseMilliC = ceilRatio([totalPowerUw, thetaJaCPerW], [1_000]);
  const junctionMilliC = ambientMilliC + riseMilliC;
  const marginMilliC = junctionLimitMilliC - junctionMilliC;

  const checks: ReferenceSimulationCheck[] = [...commonChecks(request)];
  const numericInputs =
    integer(motorSupplyMv) &&
    integer(rmsCurrentMa) &&
    motorSupplyMv > 0 &&
    rmsCurrentMa > 0;
  checks.push(
    check(
      "thermal_numeric_inputs",
      numericInputs ? "pass" : "unsupported",
      { motorSupplyMv: numericInputs ? motorSupplyMv : null, rmsCurrentMa: numericInputs ? rmsCurrentMa : null },
      "Motor-supply maximum and per-channel RMS current are positive safe integers.",
      "Unknown or non-integral operating points are not rounded into a thermal pass."
    )
  );
  const thermalPass = numericInputs && junctionMilliC < junctionLimitMilliC;
  checks.push(
    check(
      "nominal_analytic_junction_margin",
      numericInputs ? (thermalPass ? "pass" : "fail") : "unsupported",
      {
        supplyPowerUw,
        switchingPowerUw: risePowerUw + fallPowerUw,
        conductionPowerUw,
        totalPowerUw,
        ambientMilliC,
        junctionEstimateMilliC: junctionMilliC,
        junctionLimitMilliC,
        marginMilliC
      },
      "The nominal analytic estimate remains strictly below the 150 C operating-junction limit under every named model assumption.",
      "This is one driver at 0.5 A RMS; both devices are calculated identically, without claiming board-level thermal independence."
    )
  );

  const built = model(request, "motor_driver_thermal", {
    binding: {
      motorSupplyMaximumMv: motorSupplyMv,
      rmsCurrentMaPerChannel: rmsCurrentMa,
      channels: request.profile.motor.channels,
      calculatedPerDriver: {
        supplyPowerUw,
        risePowerUw,
        fallPowerUw,
        conductionPowerUw,
        totalPowerUw,
        junctionRiseMilliC: riseMilliC,
        junctionEstimateMilliC: junctionMilliC,
        marginMilliC
      }
    },
    equations: [
      equation("supply_loss", "PVM=VM*IVM", "Integer mV*mA yields microwatt.", [SOURCES.drvApplication.id]),
      equation(
        "switching_loss",
        "PSW=0.5*VM*IRMS*tRISE*fPWM + 0.5*VM*IRMS*tFALL*fPWM",
        "Integer fixed-point; each term rounds upward to microwatt.",
        [SOURCES.drvApplication.id]
      ),
      equation(
        "conduction_loss",
        "PRDS=IRMS^2*(RDS_ON_HS+RDS_ON_LS)*TEMPERATURE_MULTIPLIER",
        "Integer mA and milliohm; resistance and power round upward.",
        [SOURCES.drvApplication.id]
      ),
      equation(
        "junction_estimate",
        "TJ=TA+PTOTAL*RTHETA_JA",
        "Integer microwatt and C/W; temperature rise rounds upward to milli-C.",
        [SOURCES.drvApplication.id]
      )
    ],
    parameters: [
      parameter("vm_maximum", motorSupplyMv, "mV", "profile_contract", [], "Worst profile motor-supply endpoint."),
      parameter("irms_per_driver", rmsCurrentMa, "mA", "profile_contract", [], "Per-channel RMS profile limit."),
      parameter("active_supply_current_maximum", activeCurrentMa, "mA", "datasheet_limit", [SOURCES.drvElectrical.id], "DRV8874 active-mode current maximum."),
      parameter("pwm_frequency", switchingFrequencyHz, "Hz", "datasheet_typical", [SOURCES.drvApplication.id], "TI application design parameter adopted by Rev A."),
      parameter("rise_time", riseTimeNs, "ns", "datasheet_typical", [SOURCES.drvElectrical.id, SOURCES.drvApplication.id], "Typical, not a guaranteed maximum."),
      parameter("fall_time", fallTimeNs, "ns", "datasheet_typical", [SOURCES.drvElectrical.id, SOURCES.drvApplication.id], "Typical, not a guaranteed maximum."),
      parameter("high_side_rds_on_maximum_25c", rdsOnEachMilliohm, "milliohm", "datasheet_limit", [SOURCES.drvElectrical.id], "Maximum at 24 V, 2 A, TJ=25 C."),
      parameter("low_side_rds_on_maximum_25c", rdsOnEachMilliohm, "milliohm", "datasheet_limit", [SOURCES.drvElectrical.id], "Maximum at 24 V, 2 A, TJ=25 C."),
      parameter("rds_on_85c_multiplier", rdsTemperatureMultiplierPpm, "ppm", "datasheet_typical", [SOURCES.drvApplication.id], "TI worked procedure's approximately 1.25 normalized-temperature multiplier."),
      parameter("junction_to_ambient", thetaJaCPerW, "C/W", "datasheet_limit", [SOURCES.drvElectrical.id], "PWP thermal-information table value; board correlation is not guaranteed."),
      parameter("ambient", ambientMilliC, "milli-C", "datasheet_typical", [SOURCES.drvApplication.id], "Upper ambient from TI's -20 C to 85 C example range."),
      parameter("junction_operating_limit", junctionLimitMilliC, "milli-C", "datasheet_limit", [SOURCES.drvApplication.id], "Maximum junction used by the application example.")
    ],
    sources: [SOURCES.drvElectrical, SOURCES.drvApplication],
    tolerances: {
      arithmetic: "Every dissipative term and temperature rise rounds upward.",
      rdsTemperatureMultiplierPpm,
      timing: "150 ns rise/fall are typical values, not worst-case limits.",
      correlation: "No statistical or package-to-board correlation credit is taken."
    },
    ambientCopperDuty: {
      ambientMilliC,
      airflow: "No forced-air cooling credit.",
      copper:
        "Conditional prerequisite: the candidate six-layer Rev-A thermal-pad/via/copper implementation must achieve effective RthetaJA no worse than 36 C/W; this report does not verify that geometry.",
      boardAssumption:
        "Six-layer 1+4+1 HDI FR4 candidate with an uninterrupted ground plane and a source-bound thermal-via array, consistent in kind with the TI section 8.2.1.2.3 examples but not claimed equivalent.",
      duty: "Continuous 0.5 A RMS at 20 kHz per bridge; each driver is modeled separately."
    },
    unsupportedSubcoverage: [
      "Worst-case rise/fall timing because the PDF supplies typical values only",
      "Worst-case RDS(on) versus temperature/package/board correlation",
      "Mutual heating from both drivers, buck, LDO, enclosure, and neighboring copper",
      "Actual thermal-via fill, copper area/thickness, laminate, airflow, and enclosure",
      "Transient stall/startup thermal impedance",
      "Thermocouple or thermal-camera qualification"
    ]
  });
  return {
    model: built,
    checks,
    conclusion:
      "The pass is a nominal analytic critic with margin under the named typical timing/RDS(on), 85 C ambient, 36 C/W effective-board, no-forced-air, and continuous-duty assumptions; absent worst-case package/board correlation remains an explicit limitation."
  };
};

interface SExpressionForm {
  readonly head: string;
  readonly values: readonly (string | SExpressionForm)[];
}

interface ResetBiasRequirement {
  readonly signal: string;
  readonly nativeNetName: string;
  readonly safeRailNetName: "+3V3" | "GND";
  readonly expectedResistanceOhm: number;
  readonly requiredEndpoints: readonly NativeNetEndpoint[];
}

const RESET_BIAS_REQUIREMENTS: readonly ResetBiasRequirement[] = Object.freeze([
  {
    signal: "MOTOR_A_NSLEEP",
    nativeNetName: "M1_SLEEP",
    safeRailNetName: "GND",
    expectedResistanceOhm: 10_000,
    requiredEndpoints: [{ reference: "U1", pin: "24" }, { reference: "U6", pin: "3" }]
  },
  {
    signal: "MOTOR_B_NSLEEP",
    nativeNetName: "M2_SLEEP",
    safeRailNetName: "GND",
    expectedResistanceOhm: 10_000,
    requiredEndpoints: [{ reference: "U1", pin: "25" }, { reference: "U7", pin: "3" }]
  },
  {
    signal: "MOTOR_A_PWM",
    nativeNetName: "M1_PWM",
    safeRailNetName: "GND",
    expectedResistanceOhm: 10_000,
    requiredEndpoints: [{ reference: "U1", pin: "28" }, { reference: "U6", pin: "1" }]
  },
  {
    signal: "MOTOR_B_PWM",
    nativeNetName: "M2_PWM",
    safeRailNetName: "GND",
    expectedResistanceOhm: 10_000,
    requiredEndpoints: [{ reference: "U1", pin: "29" }, { reference: "U7", pin: "1" }]
  },
  {
    signal: "MOTOR_A_DIR",
    nativeNetName: "M1_DIR",
    safeRailNetName: "GND",
    expectedResistanceOhm: 10_000,
    requiredEndpoints: [{ reference: "U1", pin: "17" }, { reference: "U6", pin: "2" }]
  },
  {
    signal: "MOTOR_B_DIR",
    nativeNetName: "M2_DIR",
    safeRailNetName: "GND",
    expectedResistanceOhm: 10_000,
    requiredEndpoints: [{ reference: "U1", pin: "18" }, { reference: "U7", pin: "2" }]
  },
  {
    signal: "SENSOR_PWR_EN",
    nativeNetName: "SENSOR_PWR_EN",
    safeRailNetName: "GND",
    expectedResistanceOhm: 10_000,
    requiredEndpoints: [{ reference: "U1", pin: "21" }, { reference: "U8", pin: "3" }]
  },
  {
    signal: "CAN_STB",
    nativeNetName: "CAN_STB",
    safeRailNetName: "+3V3",
    expectedResistanceOhm: 10_000,
    requiredEndpoints: [{ reference: "U1", pin: "32" }, { reference: "U5", pin: "8" }]
  },
  {
    signal: "SPI_CS",
    nativeNetName: "SPI_CS",
    safeRailNetName: "+3V3",
    expectedResistanceOhm: 10_000,
    requiredEndpoints: [{ reference: "U1", pin: "37" }, { reference: "J10", pin: "6" }]
  }
]);

const NATIVE_TOPOLOGY_MAX_BYTES = 2_000_000;
const NATIVE_TOPOLOGY_MAX_FORMS = 100_000;
const NATIVE_TOPOLOGY_MAX_DEPTH = 64;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

const parseSExpression = (bytes: Uint8Array): SExpressionForm => {
  if (bytes.byteLength === 0 || bytes.byteLength > NATIVE_TOPOLOGY_MAX_BYTES) {
    throw new TypeError("Native topology source is empty or exceeds the bounded parser limit.");
  }
  const source = fatalUtf8Decoder.decode(bytes);
  let index = 0;
  let formCount = 0;
  const whitespace = (): void => {
    while (index < source.length && /\s/u.test(source[index]!)) index += 1;
  };
  const atom = (): string => {
    whitespace();
    if (source[index] === '"') {
      index += 1;
      let output = "";
      while (index < source.length) {
        const character = source[index++]!;
        if (character === '"') return output;
        if (character !== "\\") {
          output += character;
          continue;
        }
        if (index >= source.length) throw new TypeError("Native topology source has a truncated escape.");
        const escaped = source[index++]!;
        output += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
      }
      throw new TypeError("Native topology source has an unterminated string.");
    }
    const start = index;
    while (index < source.length && !/[\s()]/u.test(source[index]!)) index += 1;
    if (start === index) throw new TypeError("Native topology source contains an invalid atom.");
    return source.slice(start, index);
  };
  const form = (depth: number): SExpressionForm => {
    if (depth > NATIVE_TOPOLOGY_MAX_DEPTH || ++formCount > NATIVE_TOPOLOGY_MAX_FORMS) {
      throw new TypeError("Native topology source exceeds the bounded form limits.");
    }
    whitespace();
    if (source[index++] !== "(") throw new TypeError("Native topology source is not an S-expression.");
    const head = atom();
    const values: (string | SExpressionForm)[] = [];
    while (true) {
      whitespace();
      if (index >= source.length) throw new TypeError("Native topology source has an unterminated form.");
      if (source[index] === ")") {
        index += 1;
        return { head, values };
      }
      values.push(source[index] === "(" ? form(depth + 1) : atom());
    }
  };
  const root = form(0);
  whitespace();
  if (index !== source.length) throw new TypeError("Native topology source has trailing content.");
  return root;
};

const formChildren = (value: SExpressionForm, head: string): readonly SExpressionForm[] =>
  value.values.filter(
    (entry): entry is SExpressionForm => typeof entry !== "string" && entry.head === head
  );

const uniqueChild = (value: SExpressionForm, head: string, label: string): SExpressionForm => {
  const matches = formChildren(value, head);
  if (matches.length !== 1) throw new TypeError(`${label} must contain exactly one ${head} form.`);
  return matches[0]!;
};

const textField = (value: SExpressionForm, head: string, label: string): string => {
  const child = uniqueChild(value, head, label);
  if (child.values.length !== 1 || typeof child.values[0] !== "string" || child.values[0].length === 0) {
    throw new TypeError(`${label}.${head} must be one non-empty atom.`);
  }
  return child.values[0];
};

const parseResistanceOhm = (value: string): number | null => {
  const match = /^([0-9]+(?:\.[0-9]+)?)([kKmM]?)(?:[Rr])?(?:\s|$)/u.exec(value.trim());
  if (match === null) return null;
  const magnitude = Number(match[1]);
  const multiplier = match[2]?.toLocaleUpperCase("en-US") === "M"
    ? 1_000_000
    : match[2]?.toLocaleUpperCase("en-US") === "K"
      ? 1_000
      : 1;
  const result = magnitude * multiplier;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
};

const prepareNativeTopologySource = (
  source: ReferenceSimulationNativeTopologySource,
  enforceCanonicalBinding = true
): PreparedNativeTopologySource => {
  if (
    source.schemaVersion !== REFERENCE_SIMULATION_NATIVE_TOPOLOGY_SOURCE_SCHEMA ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(source.logicalName) ||
    source.logicalName.includes("..") ||
    source.logicalName.includes("\\") ||
    !(source.content instanceof Uint8Array) ||
    source.identity.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/u.test(source.identity.digest) ||
    !Number.isSafeInteger(source.identity.size) ||
    source.identity.size <= 0
  ) {
    throw new TypeError("Native topology source has an invalid closed envelope.");
  }
  const bytes = Uint8Array.from(source.content);
  const reproducedIdentity = contentIdentity(bytes);
  if (canonicalJson(reproducedIdentity) !== canonicalJson(source.identity)) {
    throw new TypeError("Native topology source identity does not reproduce from its exact bytes.");
  }
  const root = parseSExpression(bytes);
  if (root.head !== "export") throw new TypeError("Native topology source is not a KiCad netlist export.");
  const componentsForm = uniqueChild(root, "components", "KiCad netlist");
  const netsForm = uniqueChild(root, "nets", "KiCad netlist");
  const componentDefinitions = new Map<string, NativeComponentDefinition>();
  for (const component of formChildren(componentsForm, "comp")) {
    const reference = textField(component, "ref", "KiCad component");
    if (componentDefinitions.has(reference)) throw new TypeError("KiCad netlist has duplicate references.");
    const libsource = uniqueChild(component, "libsource", `KiCad component ${reference}`);
    const units = uniqueChild(component, "units", `KiCad component ${reference}`);
    const declaredPins = formChildren(units, "unit").flatMap((unit) =>
      formChildren(uniqueChild(unit, "pins", `KiCad component ${reference} unit`), "pin").map(
        (pin) => textField(pin, "num", `KiCad component ${reference} unit pin`)
      )
    );
    if (new Set(declaredPins).size !== declaredPins.length) {
      throw new TypeError(`KiCad component ${reference} declares a pin more than once.`);
    }
    componentDefinitions.set(reference, {
      value: textField(component, "value", `KiCad component ${reference}`),
      library: textField(libsource, "lib", `KiCad component ${reference} libsource`),
      part: textField(libsource, "part", `KiCad component ${reference} libsource`),
      declaredPins: declaredPins.sort()
    });
  }
  const endpointsByNet = new Map<string, NativeNetEndpoint[]>();
  const nodesByReference = new Map<string, NativeReferenceNode[]>();
  const nodeKeys = new Set<string>();
  for (const net of formChildren(netsForm, "net")) {
    const netName = textField(net, "name", "KiCad net");
    if (endpointsByNet.has(netName)) throw new TypeError("KiCad netlist has duplicate net names.");
    const endpoints: NativeNetEndpoint[] = [];
    for (const node of formChildren(net, "node")) {
      const endpoint = {
        reference: textField(node, "ref", `KiCad net ${netName} node`),
        pin: textField(node, "pin", `KiCad net ${netName} node`)
      };
      const component = componentDefinitions.get(endpoint.reference);
      if (component === undefined) {
        throw new TypeError(`KiCad net ${netName} references undeclared component ${endpoint.reference}.`);
      }
      if (!component.declaredPins.includes(endpoint.pin)) {
        throw new TypeError(
          `KiCad net ${netName} references undeclared pin ${endpoint.reference}.${endpoint.pin}.`
        );
      }
      const nodeKey = `${endpoint.reference}\u0000${endpoint.pin}`;
      if (nodeKeys.has(nodeKey)) throw new TypeError("KiCad netlist assigns one pin to multiple nets.");
      nodeKeys.add(nodeKey);
      endpoints.push(endpoint);
      const referenceNodes = nodesByReference.get(endpoint.reference) ?? [];
      referenceNodes.push({ netName, pin: endpoint.pin });
      nodesByReference.set(endpoint.reference, referenceNodes);
    }
    endpointsByNet.set(netName, endpoints.sort((left, right) =>
      `${left.reference}\u0000${left.pin}`.localeCompare(`${right.reference}\u0000${right.pin}`, "en-US")
    ));
  }
  const initialFacts = RESET_BIAS_REQUIREMENTS.map((requirement): ResetBiasTopologyFact => {
    const observedEndpoints = endpointsByNet.get(requirement.nativeNetName) ?? [];
    const findings: ResetBiasFindingCode[] = [];
    if (!endpointsByNet.has(requirement.nativeNetName)) findings.push("NATIVE_NET_MISSING");
    if (requirement.requiredEndpoints.some((required) =>
      !observedEndpoints.some((observed) =>
        observed.reference === required.reference && observed.pin === required.pin
      )
    )) findings.push("REQUIRED_ENDPOINT_MISSING");
    const resistorObservations = observedEndpoints
      .filter((endpoint) => {
        const component = componentDefinitions.get(endpoint.reference);
        return /^R[0-9]+$/u.test(endpoint.reference) ||
          (component?.library === "Device" && component.part === "R");
      })
      .map((endpoint): NativeBiasResistorObservation => {
        const component = componentDefinitions.get(endpoint.reference);
        const referenceNodes = nodesByReference.get(endpoint.reference) ?? [];
        return {
          reference: endpoint.reference,
          value: component?.value ?? "",
          resistanceOhm: parseResistanceOhm(component?.value ?? ""),
          componentLibrary: component?.library ?? "",
          componentPart: component?.part ?? "",
          resistorTypeValid: component?.library === "Device" && component.part === "R",
          connectedPins: [...new Set(referenceNodes.map((node) => node.pin))].sort(),
          connectedNets: [...new Set(referenceNodes.map((node) => node.netName))].sort()
        };
      });
    if (resistorObservations.length === 0) {
      findings.push("BIAS_RESISTOR_MISSING");
    } else if (resistorObservations.length > 1) {
      findings.push("BIAS_RESISTOR_AMBIGUOUS");
    }
    for (const resistor of resistorObservations) {
      if (!resistor.resistorTypeValid) findings.push("BIAS_COMPONENT_TYPE_MISMATCH");
      const expectedNets = [requirement.nativeNetName, requirement.safeRailNetName].sort();
      if (
        resistor.connectedPins.length !== 2 ||
        resistor.connectedNets.length !== 2 ||
        canonicalJson(resistor.connectedNets) !== canonicalJson(expectedNets)
      ) {
        findings.push("BIAS_RESISTOR_TOPOLOGY_INVALID");
      }
      if (!resistor.connectedNets.includes(requirement.safeRailNetName)) {
        findings.push("BIAS_RAIL_MISMATCH");
      }
      if (resistor.resistanceOhm !== requirement.expectedResistanceOhm) {
        findings.push("BIAS_VALUE_MISMATCH");
      }
    }
    const uniqueFindings = [...new Set(findings)];
    return {
      signal: requirement.signal,
      nativeNetName: requirement.nativeNetName,
      safeRailNetName: requirement.safeRailNetName,
      expectedResistanceOhm: requirement.expectedResistanceOhm,
      requiredEndpoints: requirement.requiredEndpoints,
      observedEndpoints,
      observedBiasResistors: resistorObservations,
      findings: uniqueFindings,
      status: uniqueFindings.length === 0 ? "pass" : "fail"
    };
  });
  const signalsByResistor = new Map<string, Set<string>>();
  for (const fact of initialFacts) {
    for (const resistor of fact.observedBiasResistors) {
      const signals = signalsByResistor.get(resistor.reference) ?? new Set<string>();
      signals.add(fact.signal);
      signalsByResistor.set(resistor.reference, signals);
    }
  }
  const facts = initialFacts.map((fact): ResetBiasTopologyFact => {
    const reused = fact.observedBiasResistors.some(
      (resistor) => (signalsByResistor.get(resistor.reference)?.size ?? 0) > 1
    );
    if (!reused) return fact;
    const findings = [...fact.findings, "BIAS_RESISTOR_REUSED" as const];
    return { ...fact, findings, status: "fail" };
  });
  const evidence: NativeResetTopologyEvidence = {
    schemaVersion: "evleda.reference-reset-topology-evidence.v1",
    sourceLogicalName: source.logicalName,
    sourceIdentity: reproducedIdentity,
    nativeContractIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
    canonicalSourceBinding: referenceControllerRevASourceBinding("schematic_netlist"),
    facts,
    passingFactCount: facts.filter((fact) => fact.status === "pass").length,
    failingFactCount: facts.filter((fact) => fact.status === "fail").length
  };
  const canonicalSourceBinding = referenceControllerRevASourceBinding("schematic_netlist");
  const canonicalSourceMatch =
    source.logicalName === canonicalSourceBinding.path &&
    canonicalJson(reproducedIdentity) === canonicalJson(canonicalSourceBinding.identity);
  if (enforceCanonicalBinding && !canonicalSourceMatch) {
    throw new TypeError(
      "Native topology source does not match the trusted Rev-A schematic_netlist contract binding."
    );
  }
  return {
    logicalName: source.logicalName,
    identity: reproducedIdentity,
    nativeContractIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
    canonicalSourceBinding,
    evidence
  };
};

/**
 * Parses arbitrary exact bytes for diagnostics and tests only. The result is explicitly
 * non-authoritative and cannot be supplied to ReferenceSimulationBackend as evidence.
 */
export const inspectReferenceSimulationTopologyDiagnostics = (
  source: ReferenceSimulationNativeTopologySource
): ReferenceSimulationTopologyDiagnostics => {
  const prepared = prepareNativeTopologySource(source, false);
  return {
    schemaVersion: "evleda.reference-simulation-topology-diagnostics.v1",
    authority: "diagnostic_only_not_evidence",
    sourceLogicalName: prepared.logicalName,
    sourceIdentity: prepared.identity,
    canonicalSourceMatch:
      prepared.logicalName === prepared.canonicalSourceBinding.path &&
      canonicalJson(prepared.identity) === canonicalJson(prepared.canonicalSourceBinding.identity),
    facts: prepared.evidence.facts,
    passingFactCount: prepared.evidence.passingFactCount,
    failingFactCount: prepared.evidence.failingFactCount
  };
};

const hasIdentity = (identities: readonly ContentIdentity[], expected: ContentIdentity): boolean =>
  identities.some((identity) => canonicalJson(identity) === canonicalJson(expected));

const faultResetModel = (
  request: SimulationRequest,
  nativeTopology: PreparedNativeTopologySource | null
): ModelBuild => {
  const profile = request.profile;
  const topologySourceBound =
    nativeTopology !== null && hasIdentity(request.upstreamArtifactIdentities, nativeTopology.identity);
  const hardwareBiasStatus: CheckStatus =
    nativeTopology === null
      ? "not_run"
      : !topologySourceBound
        ? "unsupported"
        : nativeTopology.evidence.failingFactCount > 0
          ? "fail"
          : "pass";
  const requiredResources = ["fault_inputs", "board_revision", "clock_and_reset"];
  const pinnedMcuCapabilityEvidencePresent = false;
  const compiledFirmwareConfigurationEvidencePresent = false;

  const transitions = [
    {
      event: "power_on_or_external_reset",
      resultingState: "disabled_unvalidated",
      motorNSleep: "requires_verified_external_low_bias",
      motorPwm: "requires_verified_external_low_bias",
      sensorEnable: "requires_verified_external_low_bias",
      canMode: "requires_verified_external_standby_bias",
      faultLatch: "set_by_initialization_before_enable"
    },
    {
      event: "brownout",
      resultingState: "disabled_brownout",
      motorNSleep: "requires_verified_external_low_bias_during_mcu_reset",
      motorPwm: "requires_verified_external_low_bias_during_mcu_reset",
      sensorEnable: "requires_verified_external_low_bias_during_mcu_reset",
      canMode: "protected_or_standby",
      faultLatch: "required_on_restart"
    },
    {
      event: "motor_driver_fault",
      resultingState: "disabled_latched_fault",
      motorNSleep: "command_low_both_channels",
      motorPwm: "command_zero_both_channels",
      sensorEnable: "unchanged_unless_fault_policy_escalates",
      canMode: "diagnostic_only",
      faultLatch: "set"
    },
    {
      event: "sensor_power_fault",
      resultingState: "disabled_latched_fault",
      motorNSleep: "command_low_both_channels",
      motorPwm: "command_zero_both_channels",
      sensorEnable: "command_low_and_tps2553_1_latched_off",
      canMode: "diagnostic_only",
      faultLatch: "set"
    },
    {
      event: "watchdog_reset",
      resultingState: "disabled_unvalidated",
      motorNSleep: "requires_verified_external_low_bias_during_reset",
      motorPwm: "requires_verified_external_low_bias_during_reset",
      sensorEnable: "requires_verified_external_low_bias_during_reset",
      canMode: "requires_verified_external_standby_bias",
      faultLatch: "required_on_restart"
    },
    {
      event: "communications_loss",
      resultingState: "disabled_latched_fault",
      motorNSleep: "command_low_both_channels",
      motorPwm: "command_zero_both_channels",
      sensorEnable: "policy_defined_safe_state",
      canMode: "diagnostic_or_standby",
      faultLatch: "set"
    },
    {
      event: "explicit_enable_request",
      guard:
        "board_revision_valid && rails_valid && no_driver_fault && no_sensor_fault && watchdog_valid && communications_valid && zero_command",
      resultingState: "enabled_candidate_operation",
      motorNSleep: "may_rise_only_after_guard",
      motorPwm: "may_leave_zero_only_after_guard",
      sensorEnable: "may_rise_only_after_guard",
      canMode: "normal_only_after_configuration",
      faultLatch: "clear_only_by_explicit_reviewed_recovery"
    }
  ];
  const noPrevalidationEnergizedState = transitions
    .filter((transition) => transition.event !== "explicit_enable_request")
    .every(
      (transition) =>
        !transition.motorNSleep.includes("rise") &&
        !transition.motorPwm.includes("leave_zero") &&
        !transition.sensorEnable.includes("rise")
    );

  const three = rail(profile, "3V3");
  const threeMinimumMv = three?.minimumMv ?? 0;
  const bor4RisingMaximumMv = 3_000;
  const checks: ReferenceSimulationCheck[] = [...commonChecks(request)];
  checks.push(
    check(
      "native_reset_topology_source",
      nativeTopology === null ? "not_run" : topologySourceBound ? "pass" : "unsupported",
      {
        sourcePresent: nativeTopology !== null,
        sourceBoundToUpstreamArtifact: topologySourceBound,
        sourceSize: nativeTopology?.identity.size ?? null
      },
      "Reset-bias analysis requires exact KiCad netlist bytes whose reproduced identity is an upstream artifact of this request.",
      nativeTopology === null
        ? "No native topology bytes were provisioned, so hardware reset-bias analysis was not run."
        : topologySourceBound
          ? "The exact native topology source is bound to this request."
          : "The provided native topology bytes are not bound as an upstream artifact of this request."
    ),
    check(
      "hardware_reset_biases",
      hardwareBiasStatus,
      {
        topologySourceBound,
        requiredBiasCount: RESET_BIAS_REQUIREMENTS.length,
        passingBiasCount: topologySourceBound ? nativeTopology!.evidence.passingFactCount : 0,
        failingBiasCount: topologySourceBound ? nativeTopology!.evidence.failingFactCount : 0
      },
      "Every reset-controlled motor, sensor-power, CAN-standby, and SPI-select signal has the required physical endpoints and one exact external bias resistor to the required safe rail.",
      hardwareBiasStatus === "pass"
        ? "The conclusion is derived from exact bound native netlist nodes and component values, not profile prose."
        : hardwareBiasStatus === "fail"
          ? "The bound native topology is missing, misroutes, or uses the wrong value for one or more required external biases."
          : "No bound native topology evidence is available; no hardware-reset PASS is emitted."
    ),
    check(
      "fault_and_revision_resources",
      "not_run",
      {
        pinnedMcuCapabilityEvidencePresent,
        compiledFirmwareConfigurationEvidencePresent
      },
      "Protocol, alternate-function, interrupt, DMA, fault-latch, and board-revision resource claims require both a pinned MCU capability source and compiled implementation evidence.",
      "Native connectivity and copied profile resources cannot establish firmware configuration; this check remains not run."
    ),
    check(
      "transition_invariant",
      "not_run",
      {
        transitionCount: transitions.length,
        logicalTableConsistent: noPrevalidationEnergizedState,
        compiledTransitionEvidencePresent: false
      },
      "Transition behavior requires compiled implementation evidence bound to the exact firmware and revision.",
      "The logical requirement table is internally consistent, but no compiled implementation evidence is present; behavior remains not run."
    ),
    check(
      "normal_rail_above_bor4_release",
      three !== undefined && integer(three.minimumMv)
        ? threeMinimumMv > bor4RisingMaximumMv
          ? "pass"
          : "fail"
        : "unsupported",
      { threeV3MinimumMv: three?.minimumMv ?? null, bor4RisingMaximumMv },
      "The normal 3V3 minimum is strictly above the maximum BOR4 rising threshold.",
      "BOR4 configuration is a firmware prerequisite; this numerical comparison does not prove option/configuration state."
    )
  );

  const built = model(request, "fault_and_reset", {
    binding: {
      safeBiasSignals: RESET_BIAS_REQUIREMENTS.map((requirement) => requirement.signal),
      nativeResetTopologyEvidence: nativeTopology?.evidence ?? null,
      requiredResources,
      implementationEvidence: {
        pinnedMcuCapabilityEvidencePresent,
        compiledFirmwareConfigurationEvidencePresent,
        status: "not_run"
      },
      transitions,
      threeV3MinimumMv: three?.minimumMv ?? null
    },
    equations: [
      equation(
        "safe_transition_invariant",
        "FOR EACH event != explicit_enable_request: motorNSLEEP!=enabled AND motorPWM=zero AND sensorEN!=enabled",
        "Deterministic enumeration over the canonical transition table.",
        [SOURCES.drvProtection.id, SOURCES.tpsLatch.id, SOURCES.tcanModes.id]
      ),
      equation(
        "brownout_release_margin",
        "V3V3_MIN > VBOR4_RISING_MAX",
        "Integer mV strict comparison.",
        [SOURCES.stmReset.id]
      )
    ],
    parameters: [
      parameter("drv_nsleep_low_maximum", 800, "mV", "datasheet_limit", [SOURCES.drvElectrical.id], "Maximum logic-low threshold for VM >= 5 V."),
      parameter("drv_nsleep_high_minimum", 1_500, "mV", "datasheet_limit", [SOURCES.drvElectrical.id], "Minimum logic-high threshold."),
      parameter("drv_internal_input_pulldown", 100_000, "ohm", "datasheet_typical", [SOURCES.drvElectrical.id], "Internal input pulldown; Rev A additionally requires external pulldowns."),
      parameter("drv_turnoff_time_typical", 1_000, "us", "datasheet_typical", [SOURCES.drvElectrical.id], "nSLEEP low to sleep mode."),
      parameter("drv_uvlo_rising_maximum", 4_600, "mV", "datasheet_limit", [SOURCES.drvElectrical.id], "VM UVLO rising maximum."),
      parameter("drv_uvlo_falling_minimum", 4_200, "mV", "datasheet_limit", [SOURCES.drvElectrical.id], "VM UVLO falling minimum."),
      parameter("tps_enable_low_maximum", 660, "mV", "datasheet_limit", [SOURCES.tpsElectrical.id], "TPS2553 active-high EN logic-low maximum."),
      parameter("tps_fault_deglitch_maximum", 10_000, "us", "datasheet_limit", [SOURCES.tpsElectrical.id], "Overcurrent FAULT assertion/deassertion maximum."),
      parameter("tps_current_limit_49k9_minimum", 475, "mA", "datasheet_limit", [SOURCES.tpsElectrical.id], "Full-temperature current-limit minimum."),
      parameter("tps_current_limit_49k9_maximum", 565, "mA", "datasheet_limit", [SOURCES.tpsElectrical.id], "Full-temperature current-limit maximum."),
      parameter("tcan_mode_change_maximum", 30, "us", "datasheet_limit", [SOURCES.tcanModes.id], "Normal/standby mode-change maximum."),
      parameter("tcan_startup_maximum", 1_500, "us", "datasheet_limit", [SOURCES.tcanModes.id], "After VCC/VIO clears UV+ before normal operation can resume."),
      parameter("tcan_vcc_uvlo_rising_maximum", 2_900, "mV", "datasheet_limit", [SOURCES.tcanSupply.id], "VCC undervoltage detection rising maximum."),
      parameter("stm32_por_tempo_maximum", 400, "us", "datasheet_limit", [SOURCES.stmReset.id], "POR temporization maximum."),
      parameter("stm32_bor4_rising_maximum", bor4RisingMaximumMv, "mV", "datasheet_limit", [SOURCES.stmReset.id], "BOR4 rising threshold maximum."),
      parameter("stm32_bor4_falling_maximum", 2_900, "mV", "datasheet_limit", [SOURCES.stmReset.id], "BOR4 falling threshold maximum."),
      parameter("lmr_uvlo_rising_maximum", 4_500, "mV", "datasheet_limit", [SOURCES.lmrElectrical.id], "VIN UVLO rising maximum."),
      parameter("tlv_uvlo_rising_maximum", 1_440, "mV", "datasheet_limit", [SOURCES.tlvElectrical.id], "LDO UVLO rising maximum."),
      parameter("usblc6_vbus_leakage_maximum", 150, "nA", "datasheet_limit", [SOURCES.usbProtection.id], "Protection-device leakage only; not a back-power qualification."),
      parameter("required_external_safe_bias", 10_000, "ohm", "revision_a_design_value", [], "Required external reset-bias value; observed values and missing devices come only from bound native topology evidence.")
    ],
    sources: [
      SOURCES.drvElectrical,
      SOURCES.drvProtection,
      SOURCES.tpsElectrical,
      SOURCES.tpsLatch,
      SOURCES.tcanSupply,
      SOURCES.tcanModes,
      SOURCES.stmReset,
      SOURCES.lmrElectrical,
      SOURCES.tlvElectrical,
      SOURCES.usbProtection
    ],
    tolerances: {
      thresholdSelection: "Worst listed threshold endpoint is used for each strict comparison.",
      timing: "Maximum is used when provided; typical-only timing is labeled typical and is not a safety response bound.",
      resetBias: "Only exact bound native topology can establish an external Rev-A bias; profile prose is not evidence."
    },
    ambientCopperDuty: {
      ambient: "No temperature-dependent response-time claim; source threshold ranges apply only under their stated conditions.",
      copper: "No fault-energy, trace-fusing, or ground-bounce model.",
      duty: "State invariant only; event duration and repeated-fault duty are not modeled."
    },
    unsupportedSubcoverage: [
      "Actual firmware, option-byte, BOR-level, watchdog, and communication-timeout configuration",
      "MCU alternate-function, interrupt, DMA, and protocol configuration without pinned capability and compiled implementation evidence",
      "Analog rail ramp, reset-pin waveform, metastability, and GPIO handoff timing",
      "Fault energy, simultaneous faults, ground shift, back-power paths, and ESD behavior",
      "Real injected-fault and power-sequencing tests",
      "Safety integrity, diagnostic coverage, or certified protective function"
    ],
    evidenceInputs: nativeTopology === null
      ? []
      : [{
          role: "native_schematic_topology",
          logicalName: nativeTopology.logicalName,
          identity: nativeTopology.identity,
          nativeContractIdentity: nativeTopology.nativeContractIdentity,
          canonicalSourceBinding: nativeTopology.canonicalSourceBinding,
          bindingStatus: topologySourceBound ? "bound" : "unbound"
        }]
  });
  return {
    model: built,
    checks,
    conclusion:
      nativeTopology === null
        ? "Hardware reset-bias analysis was not run because no exact native topology source was provisioned; protocol and resource implementation also remains not run."
        : !topologySourceBound
          ? "The supplied topology is not bound to this request, so no hardware conclusion is available; protocol and resource implementation remains not run."
          : nativeTopology.evidence.failingFactCount > 0
            ? "Bound native topology contradicts one or more required external reset-bias facts; protocol and resource implementation remains not run."
            : "Bound native topology contains the required external reset-bias network, but protocol and resource implementation remains not run without pinned capability and compiled evidence."
  };
};

const buildModel = (
  request: SimulationRequest,
  coverageItem: SimulationCoverageItem,
  nativeTopology: PreparedNativeTopologySource | null
): ModelBuild => {
  switch (coverageItem) {
    case "power_tree_operating_points":
      return powerTreeModel(request);
    case "logic_rail_load_budget":
      return logicBudgetModel(request);
    case "motor_current_chop":
      return motorChopModel(request);
    case "motor_driver_thermal":
      return motorThermalModel(request);
    case "fault_and_reset":
      return faultResetModel(request, nativeTopology);
  }
};

const CALCULATION_ONLY_COVERAGE = new Set<SimulationCoverageItem>([
  "power_tree_operating_points",
  "logic_rail_load_budget",
  "motor_current_chop",
  "motor_driver_thermal"
]);

const truthfulnessChecks = (
  request: SimulationRequest,
  coverageItem: SimulationCoverageItem,
  simulationModel: ReferenceSimulationModel,
  nativeTopology: PreparedNativeTopologySource | null
): readonly ReferenceSimulationCheck[] => {
  const nativeSchematicImplementationBound =
    nativeTopology !== null && hasIdentity(request.upstreamArtifactIdentities, nativeTopology.identity);
  const checks: ReferenceSimulationCheck[] = [
    check(
      "requirements_verification_acceptance_allocation",
      "not_run",
      {
        requirementsDocumentPresent: true,
        requirementsAllocated: false,
        exclusionsAllocated: false,
        verificationAllocated: false,
        acceptanceAllocated: false
      },
      "PASS requires an exact allocation covering every requirement, exclusion, verification obligation, and acceptance criterion.",
      "SimulationRequest carries a requirements document but no complete source-bound allocation artifact; this gate remains not run."
    ),
    check(
      "unsupported_subcoverage",
      simulationModel.unsupportedSubcoverage.length === 0 ? "pass" : "not_run",
      { unsupportedSubcoverageCount: simulationModel.unsupportedSubcoverage.length },
      "PASS requires zero unsupported subcoverage entries.",
      simulationModel.unsupportedSubcoverage.length === 0
        ? "The model declares no unsupported subcoverage."
        : "One or more declared coverage items remain unsupported or unexecuted, so aggregate PASS is forbidden."
    )
  ];
  if (CALCULATION_ONLY_COVERAGE.has(coverageItem)) {
    checks.push(
      check(
        "implementation_input_binding",
        "not_run",
        {
          nativeSchematicImplementationBound,
          compiledImplementationBound: false,
          nativePcbImplementationBound: false
        },
        "A calculation may become implementation evidence only when exact native schematic, compiled firmware, and native PCB implementation inputs are all bound.",
        "This backend has no compiled-firmware or native-PCB implementation input contract; the calculation remains diagnostic and not run as implementation verification."
      )
    );
  }
  if (coverageItem === "motor_current_chop") {
    checks.push(
      check(
        "approved_current_chop_excursion_band",
        "not_run",
        { approvedExcursionBandPresent: false },
        "Current-chop compliance requires an approved minimum and maximum excursion band bound to the exact requirements and design revision.",
        "No approved excursion band is present; the threshold calculation cannot become a compliance PASS."
      )
    );
  }
  return checks;
};

const reportStatus = (checks: readonly ReferenceSimulationCheck[]): CheckStatus => {
  if (checks.some((candidate) => candidate.status === "fail")) {
    return "fail";
  }
  if (checks.some((candidate) => candidate.status === "unsupported")) {
    return "unsupported";
  }
  if (checks.some((candidate) => candidate.status === "not_run")) {
    return "not_run";
  }
  return "pass";
};

const conclusionForStatus = (
  coverageItem: SimulationCoverageItem,
  status: CheckStatus,
  passingConclusion: string
): string => {
  switch (status) {
    case "pass":
      return passingConclusion;
    case "fail":
      return `${coverageItem} failed one or more deterministic checks; no passing engineering conclusion is available. Resolve every failed check and regenerate the report.`;
    case "unsupported":
      return `${coverageItem} is unsupported because one or more required source, profile, model, or evidence inputs are outside the pinned contract; no passing engineering conclusion is available.`;
    case "not_run":
      return `${coverageItem} was not run because required evidence is absent; no passing engineering conclusion is available.`;
  }
};

const reportFor = (
  request: SimulationRequest,
  coverageItem: SimulationCoverageItem,
  nativeTopology: PreparedNativeTopologySource | null
): SimulationReport => {
  const built = buildModel(request, coverageItem, nativeTopology);
  const checks = [
    ...built.checks,
    ...truthfulnessChecks(request, coverageItem, built.model, nativeTopology)
  ];
  const modelIdentity = canonicalIdentity(built.model, REFERENCE_SIMULATION_MODEL_SCHEMA);
  const validationStatus = reportStatus(checks);
  const document: ReferenceSimulationReportDocument = {
    schemaVersion: REFERENCE_SIMULATION_REPORT_SCHEMA,
    coverageItem,
    sourceRevisionDigest: request.expectedSourceRevisionDigest,
    modelIdentity,
    model: built.model,
    validationStatus,
    checks,
    conclusion: conclusionForStatus(coverageItem, validationStatus, built.conclusion),
    evidenceBoundary: [
      "This report is deterministic analytic critic evidence, not SPICE/FEA, physical qualification, safety proof, certification, or manufacturing release authorization.",
      "A pass means only that this report's named equations and acceptance checks pass under the canonical parameter and assumption identity.",
      "Unsupported subcoverage remains unsupported even when the narrow modeled check passes.",
      "Bench measurements, source review, layout review, and human engineering qualification remain mandatory."
    ]
  };
  return {
    coverageItem,
    logicalName: `simulation/reference/${coverageItem}.json`,
    mediaType: "application/json",
    content: textEncoder.encode(canonicalJson(document)),
    sourceRevisionDigest: request.expectedSourceRevisionDigest,
    modelIdentity,
    validationStatus
  };
};

const TOOL_IDENTITY: ToolIdentity = {
  name: "evleda-reference-analytic-critic",
  version: REFERENCE_SIMULATION_MODEL_VERSION,
  adapter: "evleda",
  capabilityProfile: REFERENCE_SIMULATION_BACKEND_ID
};

const unsupportedInputReport = (
  coverageItem: SimulationCoverageItem,
  sourceRevisionDigest: string,
  issue: SimulationInputIssue
): SimulationReport => {
  const simulationModel: ReferenceSimulationModel = {
    schemaVersion: REFERENCE_SIMULATION_MODEL_SCHEMA,
    modelVersion: REFERENCE_SIMULATION_MODEL_VERSION,
    coverageItem,
    criticScope:
      "Model execution was skipped before arithmetic because the simulation request failed closed input-domain validation.",
    profileBinding: {
      inputStatus: "unsupported",
      issueCode: issue.code,
      issuePath: issue.path
    },
    equations: [],
    parameters: [],
    sources: [],
    toleranceAssumptions: {},
    ambientCopperAndDutyAssumptions: {},
    unsupportedSubcoverage: [
      "All calculation and implementation coverage is unsupported until the input-domain error is corrected."
    ],
    evidenceInputs: []
  };
  const checks: readonly ReferenceSimulationCheck[] = [
    check(
      "simulation_input_numeric_domain",
      "unsupported",
      { issueCode: issue.code, issuePath: issue.path },
      "Every retained input number is present, finite, integral, safely representable, and inside its closed pre-arithmetic range.",
      "The request was rejected before fixed-point arithmetic, model construction, or canonicalization of caller-controlled data."
    )
  ];
  const modelIdentity = canonicalIdentity(simulationModel, REFERENCE_SIMULATION_MODEL_SCHEMA);
  const document: ReferenceSimulationReportDocument = {
    schemaVersion: REFERENCE_SIMULATION_REPORT_SCHEMA,
    coverageItem,
    sourceRevisionDigest,
    modelIdentity,
    model: simulationModel,
    validationStatus: "unsupported",
    checks,
    conclusion: conclusionForStatus(coverageItem, "unsupported", ""),
    evidenceBoundary: [
      "No arithmetic, implementation inference, qualification, safety, or release claim is available for an invalid input domain."
    ]
  };
  return {
    coverageItem,
    logicalName: `simulation/reference/${coverageItem}.json`,
    mediaType: "application/json",
    content: textEncoder.encode(canonicalJson(document)),
    sourceRevisionDigest,
    modelIdentity,
    validationStatus: "unsupported"
  };
};

/**
 * Pure, deterministic, source-bound analytic checks for the exact v0 reference profile.
 * It never reads ambient files at execution time and never upgrades analytic evidence to
 * physical, safety, qualification, certification, or release evidence.
 */
export class ReferenceSimulationBackend implements SimulationBackend {
  public readonly backendId = REFERENCE_SIMULATION_BACKEND_ID;
  readonly #nativeTopology: PreparedNativeTopologySource | null;

  public constructor(options: ReferenceSimulationBackendOptions = {}) {
    this.#nativeTopology = options.nativeTopologySource === undefined
      ? null
      : prepareNativeTopologySource(options.nativeTopologySource);
  }

  public async execute(request: SimulationRequest): Promise<SimulationBackendResult> {
    const snapshot = snapshotSimulationRequest(request);
    const reports = snapshot.status === "valid"
      ? COVERAGE_ITEMS.map((coverageItem) =>
          reportFor(snapshot.request, coverageItem, this.#nativeTopology)
        )
      : COVERAGE_ITEMS.map((coverageItem) =>
          unsupportedInputReport(coverageItem, snapshot.sourceRevisionDigest, snapshot.issue)
        );
    return {
      schemaVersion: "evleda.simulation-result.v1",
      sourceRevisionDigest: snapshot.status === "valid"
        ? snapshot.request.expectedSourceRevisionDigest
        : snapshot.sourceRevisionDigest,
      tool: TOOL_IDENTITY,
      reports
    };
  }
}

export const createReferenceSimulationBackend = (): SimulationBackend =>
  new ReferenceSimulationBackend();

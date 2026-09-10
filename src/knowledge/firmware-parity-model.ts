import { canonicalIdentity } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type {
  PinAssignment,
  ReferenceControllerProfile,
  ResourceAllocation
} from "./reference-controller-v0.js";
import {
  REFERENCE_CONTROLLER_REV_A_MCU_REFERENCE,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_SIGNAL_ALIASES
} from "./reference-controller-native-contract.js";

export const FIRMWARE_PARITY_MAPPING_MODEL_SCHEMA =
  "evleda.firmware-parity-mapping-model.v1";
export const FIRMWARE_PARITY_NATIVE_SOURCE_SCHEMA =
  "evleda.kicad-firmware-parity-source.v1";
export const FIRMWARE_PARITY_MCU_REFERENCE = REFERENCE_CONTROLLER_REV_A_MCU_REFERENCE;

const NATIVE_NET_BY_SIGNAL = REFERENCE_CONTROLLER_REV_A_SIGNAL_ALIASES;

const NATIVE_PIN_FUNCTION_BY_PHYSICAL_PIN =
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.mcuPinFunctionOverrides;

export interface FirmwareParityPinCapability {
  readonly signal: string;
  readonly reference: typeof FIRMWARE_PARITY_MCU_REFERENCE;
  readonly physicalPin: number;
  readonly mcuPin: string;
  readonly expectedPinFunction: string;
  readonly nativeNetName: string | null;
  readonly assignment: PinAssignment;
}

export interface FirmwareResourceClaim {
  readonly owner: string;
  readonly kind: "timer" | "peripheral" | "irq" | "dma" | "mcu_pin" | "resource";
  readonly claim: string;
}

export interface FirmwareResourceConflict {
  readonly kind: FirmwareResourceClaim["kind"];
  readonly claim: string;
  readonly owners: readonly string[];
}

const normalizedToken = (value: string): string =>
  value.trim().replaceAll(/\s+/gu, " ").toUpperCase();

const claimsForAllocation = (allocation: ResourceAllocation): readonly FirmwareResourceClaim[] => {
  const claims = new Map<string, FirmwareResourceClaim>();
  const add = (kind: FirmwareResourceClaim["kind"], claim: string): void => {
    const normalized = normalizedToken(claim);
    if (normalized.length > 0) {
      claims.set(`${kind}:${normalized}`, { owner: allocation.owner, kind, claim: normalized });
    }
  };

  for (const match of allocation.resource.matchAll(/\bTIM\d+\b/giu)) add("timer", match[0]);
  for (const match of allocation.resource.matchAll(/\b(?:ADC\d+|FDCAN\d+|USART\d+|SPI\d+|I2C\d+)\b/giu)) {
    add("peripheral", match[0]);
  }
  if (/\bUSB\s+FS\b/iu.test(allocation.resource)) add("peripheral", "USB_FS");
  for (const match of allocation.resource.matchAll(/\bP[A-F]\d{1,2}\b/gu)) {
    add("mcu_pin", match[0]);
  }
  if (allocation.irq !== null) {
    for (const irq of allocation.irq.split("/")) add("irq", irq);
  }
  if (allocation.dma !== null) {
    for (const match of allocation.dma.matchAll(/\bDMA\d+_CH\d+\b/gu)) add("dma", match[0]);
  }
  add("resource", allocation.resource);
  return [...claims.values()].sort((left, right) => {
    const leftKey = `${left.kind}:${left.claim}`;
    const rightKey = `${right.kind}:${right.claim}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
};

export const firmwareResourceClaims = (
  profile: ReferenceControllerProfile
): readonly FirmwareResourceClaim[] =>
  profile.resources
    .flatMap((allocation) => claimsForAllocation(allocation))
    .sort((left, right) => {
      const leftKey = `${left.kind}:${left.claim}:${left.owner}`;
      const rightKey = `${right.kind}:${right.claim}:${right.owner}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

export const firmwareResourceConflicts = (
  profile: ReferenceControllerProfile
): readonly FirmwareResourceConflict[] => {
  const ownersByClaim = new Map<
    string,
    { readonly kind: FirmwareResourceClaim["kind"]; readonly claim: string; readonly owners: Set<string> }
  >();
  for (const resourceClaim of firmwareResourceClaims(profile)) {
    const key = `${resourceClaim.kind}:${resourceClaim.claim}`;
    const existing = ownersByClaim.get(key) ?? {
      kind: resourceClaim.kind,
      claim: resourceClaim.claim,
      owners: new Set<string>()
    };
    existing.owners.add(resourceClaim.owner);
    ownersByClaim.set(key, existing);
  }
  return [...ownersByClaim.values()]
    .filter((entry) => entry.owners.size > 1)
    .map((entry) => ({
      kind: entry.kind,
      claim: entry.claim,
      owners: [...entry.owners].sort()
    }))
    .sort((left, right) => {
      const leftKey = `${left.kind}:${left.claim}`;
      const rightKey = `${right.kind}:${right.claim}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
};

export interface FirmwareParityMappingModel {
  readonly schemaVersion: typeof FIRMWARE_PARITY_MAPPING_MODEL_SCHEMA;
  readonly profileId: string;
  readonly boardRevision: string;
  readonly mcuReference: typeof FIRMWARE_PARITY_MCU_REFERENCE;
  readonly nativeNetVocabulary: Readonly<Record<string, string>>;
  readonly pins: readonly FirmwareParityPinCapability[];
  readonly resources: ReferenceControllerProfile["resources"];
  readonly protocols: ReferenceControllerProfile["protocols"];
  readonly resourceClaims: readonly FirmwareResourceClaim[];
  readonly resourceConflicts: readonly FirmwareResourceConflict[];
  readonly missingSignalMappings: readonly string[];
}

export interface KicadNetlistNode {
  readonly reference: string;
  readonly pin: string;
  readonly pinFunction: string | null;
  readonly pinType: string | null;
  readonly netName: string;
}

export interface FirmwareParityNativeNode {
  readonly signal: string;
  readonly reference: string;
  readonly physicalPin: number;
  readonly mcuPin: string;
  readonly pinFunction: string;
  readonly pinType: string;
  readonly nativeNetName: string;
}

export interface FirmwareParityNodeFinding {
  readonly code:
    | "MAPPING_SIGNAL_MISSING"
    | "NATIVE_PIN_MISSING"
    | "NATIVE_PIN_DUPLICATE"
    | "NATIVE_PIN_FUNCTION_MISMATCH"
    | "NATIVE_PIN_NET_MISMATCH"
    | "NATIVE_PIN_NO_CONNECT";
  readonly signal: string;
  readonly message: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface FirmwareParityNodeDerivation {
  readonly nodes: readonly FirmwareParityNativeNode[];
  readonly pins: readonly PinAssignment[];
  readonly findings: readonly FirmwareParityNodeFinding[];
}

export const firmwareParityMappingModel = (
  profile: ReferenceControllerProfile
): FirmwareParityMappingModel => {
  const pins = profile.pins.map((assignment): FirmwareParityPinCapability => ({
    signal: assignment.signal,
    reference: FIRMWARE_PARITY_MCU_REFERENCE,
    physicalPin: assignment.physicalPin,
    mcuPin: assignment.mcuPin,
    expectedPinFunction:
      NATIVE_PIN_FUNCTION_BY_PHYSICAL_PIN[assignment.physicalPin] ??
      `${assignment.mcuPin}_${assignment.physicalPin.toString()}`,
    nativeNetName: NATIVE_NET_BY_SIGNAL[assignment.signal] ?? null,
    assignment
  }));
  return {
    schemaVersion: FIRMWARE_PARITY_MAPPING_MODEL_SCHEMA,
    profileId: profile.profileId,
    boardRevision: profile.boardRevision,
    mcuReference: FIRMWARE_PARITY_MCU_REFERENCE,
    nativeNetVocabulary: NATIVE_NET_BY_SIGNAL,
    pins,
    resources: profile.resources,
    protocols: profile.protocols,
    resourceClaims: firmwareResourceClaims(profile),
    resourceConflicts: firmwareResourceConflicts(profile),
    missingSignalMappings: pins
      .filter((pin) => pin.nativeNetName === null)
      .map((pin) => pin.signal)
      .sort()
  };
};

export const firmwareParityMappingModelIdentity = (
  profile: ReferenceControllerProfile
): CanonicalIdentity =>
  canonicalIdentity(
    firmwareParityMappingModel(profile),
    FIRMWARE_PARITY_MAPPING_MODEL_SCHEMA
  );

export const deriveFirmwareParityNodes = (
  netlistNodes: readonly KicadNetlistNode[],
  profile: ReferenceControllerProfile
): FirmwareParityNodeDerivation => {
  const model = firmwareParityMappingModel(profile);
  const nodes: FirmwareParityNativeNode[] = [];
  const pins: PinAssignment[] = [];
  const findings: FirmwareParityNodeFinding[] = [];
  for (const capability of model.pins) {
    if (capability.nativeNetName === null) {
      findings.push({
        code: "MAPPING_SIGNAL_MISSING",
        signal: capability.signal,
        message: `No trusted native-net mapping exists for ${capability.signal}.`,
        expected: capability.signal,
        actual: null
      });
      continue;
    }
    const matches = netlistNodes.filter(
      (node) =>
        node.reference === capability.reference &&
        node.pin === capability.physicalPin.toString()
    );
    if (matches.length !== 1) {
      findings.push({
        code: matches.length === 0 ? "NATIVE_PIN_MISSING" : "NATIVE_PIN_DUPLICATE",
        signal: capability.signal,
        message: `${capability.reference}.${capability.physicalPin.toString()} must occur exactly once in the captured KiCad netlist.`,
        expected: 1,
        actual: matches.length
      });
      continue;
    }
    const observed = matches[0]!;
    if (observed.pinFunction !== capability.expectedPinFunction) {
      findings.push({
        code: "NATIVE_PIN_FUNCTION_MISMATCH",
        signal: capability.signal,
        message: `${capability.signal} has the wrong MCU pin function in the captured KiCad netlist.`,
        expected: capability.expectedPinFunction,
        actual: observed.pinFunction
      });
      continue;
    }
    if (observed.netName !== capability.nativeNetName) {
      findings.push({
        code: "NATIVE_PIN_NET_MISMATCH",
        signal: capability.signal,
        message: `${capability.signal} is connected to the wrong native KiCad net.`,
        expected: capability.nativeNetName,
        actual: observed.netName
      });
      continue;
    }
    if (
      observed.pinType === null ||
      observed.pinType.toLocaleLowerCase("en-US").includes("no_connect") ||
      observed.netName.startsWith("unconnected-(")
    ) {
      findings.push({
        code: "NATIVE_PIN_NO_CONNECT",
        signal: capability.signal,
        message: `${capability.signal} is marked no-connect in the captured KiCad netlist.`,
        expected: "connected",
        actual: { pinType: observed.pinType, netName: observed.netName }
      });
      continue;
    }
    nodes.push({
      signal: capability.signal,
      reference: observed.reference,
      physicalPin: capability.physicalPin,
      mcuPin: capability.mcuPin,
      pinFunction: observed.pinFunction,
      pinType: observed.pinType,
      nativeNetName: observed.netName
    });
    pins.push(capability.assignment);
  }
  return { nodes, pins, findings };
};

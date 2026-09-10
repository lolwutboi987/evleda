import { types as nodeTypes } from "node:util";

import { canonicalJson } from "../core/canonical.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "./reference-controller-native-contract.js";
import {
  REFERENCE_CONTROLLER_V0_LIMITS,
  createReferenceControllerProfile,
  type ReferenceControllerProfile
} from "./reference-controller-v0.js";

export const CURRENT_SYSTEM_ARCHITECTURE_SCHEMA = "evleda.system-architecture.v2" as const;
/** Legacy v1 is replay-only and requires an explicit architecture-stage rerun. */
export const LEGACY_SYSTEM_ARCHITECTURE_SCHEMA = "evleda.system-architecture.v1" as const;
export const REFERENCE_SYSTEM_ARCHITECTURE_MAX_BYTES = 65_536;

const MAX_DEPTH = 16;
const MAX_NODES = 4_096;
const MAX_ARRAY_LENGTH = 256;
const MAX_OBJECT_KEYS = 256;
const MAX_STRING_LENGTH = 4_096;

export type ReferenceSystemArchitectureErrorCode =
  | "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE"
  | "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT"
  | "REFERENCE_SYSTEM_ARCHITECTURE_UNSUPPORTED_SCHEMA"
  | "REFERENCE_SYSTEM_ARCHITECTURE_UPGRADE_REQUIRED"
  | "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE";

export class ReferenceSystemArchitectureError extends Error {
  public constructor(
    public readonly code: ReferenceSystemArchitectureErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ReferenceSystemArchitectureError";
  }
}

const fail = (code: ReferenceSystemArchitectureErrorCode, message: string): never => {
  throw new ReferenceSystemArchitectureError(code, message);
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const nativeArchitectureNets = (semanticName: string): readonly string[] => {
  const aliases = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases[semanticName];
  if (aliases === undefined || aliases.length === 0) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
      `The reviewed Rev-A contract does not bind architecture net ${semanticName}.`
    );
  }
  // Emit a detached tree, not a graph with shared catalog-array references. The strict
  // validator rejects repeated object identities so caller-owned aliasing cannot hide cycles.
  return [...aliases];
};

const nativeSignal = (semanticName: string): string => {
  const alias = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.signalAliases[semanticName];
  if (alias === undefined) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
      `The reviewed Rev-A contract does not bind profile signal ${semanticName}.`
    );
  }
  return alias;
};

const correctedPowerRails = (profile: ReferenceControllerProfile) =>
  profile.rails.map((rail) => {
    const common = {
      ...rail,
      semanticName: rail.name,
      nativeNetNames: nativeArchitectureNets(rail.name),
      testPointDesignators: [] as readonly string[]
    };
    switch (rail.name) {
      case "VBAT_PROTECTED":
        return {
          ...common,
          source: "Battery input after a surface-mount resettable PTC, reverse-polarity stage, and transient protection",
          consumers: ["DRV8874 channel A", "DRV8874 channel B", "LMR51420"],
          functionalLoadDesignators: [
            ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.motor_driver,
            ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.buck_5v
          ],
          protection: ["surface-mount resettable PTC", "reverse-polarity stage", "TVS", "bulk decoupling"]
        };
      case "5V0":
        return {
          ...common,
          consumers: ["TLV75533P 3.3 V regulator", "TPS2553-1 sensor-power switch"],
          functionalLoadDesignators: [
            ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.ldo_3v3,
            ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.sensor_power_switch
          ],
          protection: ["buck cycle-by-cycle protection", "local output capacitance"]
        };
      case "3V3":
        return {
          ...common,
          consumers: [
            "STM32G0B1",
            "TCAN3413",
            "SN74LVC2G17 buffers",
            "status indicators",
            "3.3 V UART/SPI/I2C expansion headers"
          ],
          functionalLoadDesignators: [
            ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.mcu,
            ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.can_transceiver,
            ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.encoder_buffer
          ],
          protection: ["LDO current limit", "local high-frequency decoupling"]
        };
      case "5V_SENSOR":
        return {
          ...common,
          functionalLoadDesignators: [] as readonly string[]
        };
      default:
        return fail(
          "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
          `Unsupported Rev-A architecture rail ${rail.name}.`
        );
    }
  });

const interfaceResetAssessment = (name: string): string => {
  switch (name) {
    case "CAN":
      return "CAN_STB has a populated 100-kohm pull-up to the native 3.3 V rail, requesting transceiver standby while the MCU pin is high impedance.";
    case "SPI":
      return "SPI_CS has a populated pull-up; SCK, MISO, and MOSI do not have the legacy profile's claimed external pull-down network.";
    case "ENCODER":
      return "Raw encoder inputs have pull-ups; conditioned buffer outputs do not have the legacy profile's claimed pull-down network.";
    default:
      return "Reset behavior remains candidate-only and requires native-topology plus firmware validation; no safety authorization is inferred.";
  }
};

const interfaceElectrical = (
  protocol: ReferenceControllerProfile["protocols"][number]
): string =>
  protocol.name === "CAN"
    ? "ISO 11898-2 physical layer through TCAN3413; the fitted 120-ohm termination path is disabled by normally-open JP1 and is enabled only by closing JP1"
    : protocol.electrical;

export const buildReferenceSystemArchitecture = (profile: ReferenceControllerProfile) => ({
  schemaVersion: CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
  profileId: profile.profileId,
  boardRevision: profile.boardRevision,
  lifecycle: profile.lifecycle,
  nativeContractBinding: {
    semanticIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
    contentIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
  },
  nativeNetBindings: {
    architecture: Object.keys(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases)
      .sort(compareText)
      .map((semanticName) => ({
        semanticName,
        nativeNetNames: nativeArchitectureNets(semanticName)
      })),
    signals: Object.keys(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.signalAliases)
      .sort(compareText)
      .map((semanticName) => ({
        semanticName,
        nativeNetName: nativeSignal(semanticName)
      }))
  },
  functionalBlocks: [
    {
      id: "protected_input",
      function: `Accept ${profile.inputVoltageMv.minimum}-${profile.inputVoltageMv.maximum} mV battery input through a surface-mount resettable PTC, reverse-polarity, transient, and bulk-energy provisions.`,
      outputs: ["VBAT_PROTECTED"]
    },
    {
      id: "dual_motor_power",
      function: "Drive two brushed-DC motors using one DRV8874PWP per channel.",
      inputs: ["VBAT_PROTECTED", "MOTOR_A_PWM", "MOTOR_B_PWM"],
      outputs: ["MOTOR_A_OUT", "MOTOR_B_OUT", "MOTOR_A_ISENSE", "MOTOR_B_ISENSE"],
      limits: {
        rmsCurrentMaPerChannel: profile.motor.rmsCurrentMaPerChannel,
        currentChopMaPerChannel: profile.motor.currentChopMaPerChannel
      }
    },
    {
      id: "logic_power",
      function: "Generate 5V0 with LMR51420 and 3V3 with TLV75533P.",
      inputs: ["VBAT_PROTECTED"],
      outputs: ["5V0", "3V3"]
    },
    {
      id: "controller",
      function: "STM32G0B1CET6 owns actuation, sensing, communications, fault latching, and board-revision validation.",
      inputs: ["3V3", "faults", "current sense", "encoders", "communications"],
      outputs: ["motor controls", "sensor power enable", "CAN standby", "status"]
    },
    {
      id: "communications",
      function: "Provide USB device, 3.3 V CAN FD physical layer, UART, I2C, SPI, and recoverable SWD.",
      inputs: ["3V3"],
      outputs: ["USB", "CAN", "UART", "I2C", "SPI", "SWD"]
    },
    {
      id: "sensor_io",
      function: "Provide default-off current-limited 5 V sensor power and four Schmitt-conditioned quadrature inputs.",
      inputs: ["5V0", "3V3", "SENSOR_PWR_EN"],
      outputs: ["5V_SENSOR", "ENC_A_A", "ENC_A_B", "ENC_B_A", "ENC_B_B"]
    }
  ],
  powerRails: correctedPowerRails(profile),
  interfaces: profile.protocols.map((protocol) => ({
    name: protocol.name,
    electrical: interfaceElectrical(protocol),
    controller: protocol.controller,
    pins: protocol.pins,
    nativePinBindings: protocol.pins.map((signal) => ({
      signal,
      nativeNetName: nativeSignal(signal)
    })),
    defaultConfiguration: protocol.defaultConfiguration,
    resetBehaviorAssessment: interfaceResetAssessment(protocol.name)
  })),
  resetSequence: [
    "Populated 100-kohm pull-downs hold both DRV8874 nSLEEP inputs low; PWM and DIR are direct MCU controls without populated external bias resistors.",
    "A populated 100-kohm pull-down holds TPS2553-1 sensor-power enable low, and a populated 100-kohm pull-up requests TCAN3413 standby.",
    "TLV75533P and STM32G0B1 power-on/reset supervision settle; SWD remains recoverable.",
    "Firmware reads and validates the configurable BOARD_ID0/BOARD_ID1 straps before configuring peripheral alternate functions.",
    "Firmware samples bridge and sensor fault inputs and validates ADC calibration with actuators disabled.",
    "Only an explicit application command after all checks may release one bridge at a time."
  ],
  faultPolicy: [
    "Any bridge fault disables and latches both motor channels until an explicit recovery sequence.",
    "Sensor-power fault disables 5V_SENSOR without enabling or changing motor outputs.",
    "Watchdog, brownout, clock, board-ID, ADC, or firmware-contract mismatch must assert both nSLEEP controls low; native nSLEEP pull-downs provide fail-off bias only while their MCU pins are high impedance.",
    "Loss of USB, CAN, UART, I2C, or SPI traffic never implies permission to energize an actuator."
  ],
  assumptions: [
    `The ${(profile.motor.rmsCurrentMaPerChannel / 1000).toString()} A RMS/channel rating is a requested operating point, not a demonstrated thermal rating.`,
    `The ${(profile.motor.currentChopMaPerChannel / 1000).toString()} A current-chop target requires datasheet-bound resistor calculations plus modeled and bench verification.`,
    `USB is data-only; USB VBUS is protected/sensed and must not back-power ${nativeArchitectureNets("5V0")[0]!}, ${nativeArchitectureNets("3V3")[0]!}, or ${nativeArchitectureNets("VBAT_PROTECTED")[0]!}.`,
    "Connector, surface-mount resettable PTC, TVS, passives, and exact orderable buck suffix remain part of the complete schematic/BOM review; no test-point components are present in Rev-A."
  ],
  exclusions: profile.exclusions
});

export type ReferenceSystemArchitectureV2 = ReturnType<typeof buildReferenceSystemArchitecture>;

interface SnapshotBudget {
  nodes: number;
  scalarBytes: number;
}

const isArrayIndex = (key: string): boolean =>
  /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < 4_294_967_295;

const accountString = (value: string, budget: SnapshotBudget, path: string): void => {
  if (value.length > MAX_STRING_LENGTH) {
    return fail("REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE", `${path} exceeds the string limit.`);
  }
  budget.scalarBytes += Buffer.byteLength(value, "utf8");
  if (budget.scalarBytes > REFERENCE_SYSTEM_ARCHITECTURE_MAX_BYTES) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE",
      "System architecture exceeds its aggregate string budget."
    );
  }
};

const snapshotJson = (
  value: unknown,
  path: string,
  depth: number,
  budget: SnapshotBudget,
  seen: Set<object>
): unknown => {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE",
      "System architecture exceeds its structural limits."
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      return fail(
        "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
        `${path} must be a finite non-negative-zero number.`
      );
    }
    return value;
  }
  if (typeof value === "string") {
    accountString(value, budget, path);
    return value;
  }
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    if (nodeTypes.isProxy(value)) {
      return fail(
        "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
        `${path} must not contain a proxy.`
      );
    }
  }
  if (typeof value !== "object" || value === null) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
      `${path} must contain only plain JSON data.`
    );
  }
  if (seen.has(value)) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
      `${path} repeats an object or contains a cycle.`
    );
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      (lengthDescriptor.value as number) < 0
    ) {
      return fail(
        "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
        `${path} has an invalid array length.`
      );
    }
    const length = lengthDescriptor.value as number;
    if (length > MAX_ARRAY_LENGTH) {
      return fail("REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE", `${path} exceeds the array limit.`);
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && (!isArrayIndex(key) || Number(key) >= length))
      )
    ) {
      return fail(
        "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
        `${path} must be a dense array without custom properties.`
      );
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return fail(
          "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
          `${path}[${index}] must be an enumerable data property.`
        );
      }
      result.push(snapshotJson(descriptor.value, `${path}[${index}]`, depth + 1, budget, seen));
    }
    return Object.freeze(result);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
      `${path} must be a plain object.`
    );
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_OBJECT_KEYS) {
    return fail("REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE", `${path} exceeds the object-key limit.`);
  }
  if (keys.some((key) => typeof key !== "string")) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
      `${path} must not contain symbol properties.`
    );
  }
  for (const key of keys as string[]) accountString(key, budget, `${path}.key`);
  const result: Record<string, unknown> = {};
  for (const key of (keys as string[]).sort(compareText)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail(
        "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
        `${path}.${key} must be an enumerable data property.`
      );
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: snapshotJson(descriptor.value, `${path}.${key}`, depth + 1, budget, seen)
    });
  }
  return Object.freeze(result);
};

const currentRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      `${path} is missing from the current architecture.`
    );
  }
  return value as Record<string, unknown>;
};

const currentArray = (value: unknown, path: string): readonly unknown[] => {
  if (!Array.isArray(value)) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      `${path} is not an ordered current-architecture array.`
    );
  }
  return value;
};

const currentPositiveInteger = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      `${path} is not a positive safe integer.`
    );
  }
  return value as number;
};

const canonicalEqual = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
};

const snapshotCurrentArchitecture = (value: unknown): unknown => {
  const snapshot = snapshotJson(
    value,
    "systemArchitecture",
    0,
    { nodes: 0, scalarBytes: 0 },
    new Set<object>()
  );
  const suppliedSchema =
    typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>).schemaVersion
      : undefined;
  if (suppliedSchema === LEGACY_SYSTEM_ARCHITECTURE_SCHEMA) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_UPGRADE_REQUIRED",
      "Legacy system architecture v1 is replay-only and requires an explicit architecture-stage rerun."
    );
  }
  if (suppliedSchema !== CURRENT_SYSTEM_ARCHITECTURE_SCHEMA) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_UNSUPPORTED_SCHEMA",
      "System architecture does not use the current supported schema."
    );
  }
  let encoded: string;
  try {
    encoded = canonicalJson(snapshot);
  } catch {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE",
      "System architecture cannot be canonically encoded."
    );
  }
  if (Buffer.byteLength(encoded, "utf8") > REFERENCE_SYSTEM_ARCHITECTURE_MAX_BYTES) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE",
      "System architecture exceeds its canonical byte limit."
    );
  }
  return snapshot;
};

export const validateAndSnapshotReferenceSystemArchitectureV2Shape = (
  value: unknown
): ReferenceSystemArchitectureV2 => {
  const snapshot = snapshotCurrentArchitecture(value);
  const root = currentRecord(snapshot, "systemArchitecture");
  if (
    root.profileId !== REFERENCE_CONTROLLER_V0_LIMITS.profileId ||
    root.boardRevision !== REFERENCE_CONTROLLER_V0_LIMITS.boardRevision ||
    root.lifecycle !== "candidate"
  ) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      "System architecture is not the current Rev-A candidate profile."
    );
  }

  const rails = currentArray(root.powerRails, "systemArchitecture.powerRails");
  const protectedRail = currentRecord(rails[0], "systemArchitecture.powerRails[0]");
  if (protectedRail.semanticName !== "VBAT_PROTECTED") {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      "The first power rail must be the ordered VBAT_PROTECTED rail."
    );
  }
  const minimum = currentPositiveInteger(
    protectedRail.minimumMv,
    "systemArchitecture.powerRails[0].minimumMv"
  );
  const maximum = currentPositiveInteger(
    protectedRail.maximumMv,
    "systemArchitecture.powerRails[0].maximumMv"
  );

  const blocks = currentArray(root.functionalBlocks, "systemArchitecture.functionalBlocks");
  const motorBlock = currentRecord(blocks[1], "systemArchitecture.functionalBlocks[1]");
  if (motorBlock.id !== "dual_motor_power") {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      "The second functional block must be the ordered dual_motor_power block."
    );
  }
  const limits = currentRecord(
    motorBlock.limits,
    "systemArchitecture.functionalBlocks[1].limits"
  );
  const rmsCurrentMaPerChannel = currentPositiveInteger(
    limits.rmsCurrentMaPerChannel,
    "systemArchitecture.functionalBlocks[1].limits.rmsCurrentMaPerChannel"
  );
  const currentChopMaPerChannel = currentPositiveInteger(
    limits.currentChopMaPerChannel,
    "systemArchitecture.functionalBlocks[1].limits.currentChopMaPerChannel"
  );

  const profile = createReferenceControllerProfile({
    inputVoltageMv: { minimum, maximum },
    motor: {
      channels: REFERENCE_CONTROLLER_V0_LIMITS.motor.channels,
      rmsCurrentMaPerChannel,
      currentChopMaPerChannel
    }
  });
  if (profile.parameterValidation.supportStatus !== "supported") {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      "System architecture parameters are outside the reviewed Rev-A envelope."
    );
  }

  const expected = buildReferenceSystemArchitecture(profile);
  const binding = currentRecord(
    root.nativeContractBinding,
    "systemArchitecture.nativeContractBinding"
  );
  if (
    !canonicalEqual(
      binding.semanticIdentity,
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
    ) ||
    !canonicalEqual(
      binding.contentIdentity,
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
    )
  ) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      "System architecture does not bind both exact reviewed native-contract identities."
    );
  }
  if (!canonicalEqual(root.nativeNetBindings, expected.nativeNetBindings)) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      "System architecture does not contain the full ordered native-net binding set."
    );
  }
  if (!canonicalEqual(snapshot, expected)) {
    return fail(
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT",
      "System architecture does not exactly match the current deterministic Rev-A architecture."
    );
  }
  return snapshot as ReferenceSystemArchitectureV2;
};

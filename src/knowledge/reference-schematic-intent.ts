import { types as nodeTypes } from "node:util";

import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "./reference-controller-native-contract.js";
import {
  ROBOTICS_CONTROLLER_V0,
  type ReferenceControllerProfile
} from "./reference-controller-v0.js";

export const CURRENT_SCHEMATIC_INTENT_SCHEMA = "evleda.schematic-intent.v2" as const;
export const LEGACY_SCHEMATIC_INTENT_SCHEMA = "evleda.schematic-intent.v1" as const;
export const REFERENCE_SCHEMATIC_INTENT_MAX_BYTES = 65_536;

const MAX_DEPTH = 16;
const MAX_NODES = 4_096;
const MAX_ARRAY_LENGTH = 256;
const MAX_OBJECT_KEYS = 256;
const MAX_STRING_LENGTH = 4_096;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength"
)?.get;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer"
)?.get;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

export type ReferenceSchematicIntentErrorCode =
  | "REFERENCE_SCHEMATIC_INTENT_BYTES_INVALID"
  | "REFERENCE_SCHEMATIC_INTENT_INVALID_JSON"
  | "REFERENCE_SCHEMATIC_INTENT_IDENTITY_INVALID"
  | "REFERENCE_SCHEMATIC_INTENT_IDENTITY_MISMATCH"
  | "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE"
  | "REFERENCE_SCHEMATIC_INTENT_NON_CANONICAL_JSON"
  | "REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT"
  | "REFERENCE_SCHEMATIC_INTENT_UNSUPPORTED_SCHEMA"
  | "REFERENCE_SCHEMATIC_INTENT_UPGRADE_REQUIRED"
  | "REFERENCE_SCHEMATIC_INTENT_TOO_LARGE";

export class ReferenceSchematicIntentError extends Error {
  public constructor(
    public readonly code: ReferenceSchematicIntentErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ReferenceSchematicIntentError";
  }
}

const fail = (code: ReferenceSchematicIntentErrorCode, message: string): never => {
  throw new ReferenceSchematicIntentError(code, message);
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const nativeArchitectureNetNames = (semanticName: string): readonly string[] => {
  const aliases = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases[semanticName];
  if (aliases === undefined || aliases.length === 0) {
    throw new ReferenceSchematicIntentError(
      "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE",
      `The reviewed Rev-A contract does not explicitly bind architecture net ${semanticName}.`
    );
  }
  return aliases;
};

const nativeSignalName = (semanticName: string): string => {
  const alias = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.signalAliases[semanticName];
  if (alias === undefined) {
    throw new ReferenceSchematicIntentError(
      "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE",
      `The reviewed Rev-A contract does not explicitly bind profile signal ${semanticName}.`
    );
  }
  return alias;
};

const singleArchitectureNet = (semanticName: string): string => {
  const names = nativeArchitectureNetNames(semanticName);
  if (names.length !== 1) {
    throw new ReferenceSchematicIntentError(
      "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE",
      `Schematic net ${semanticName} must bind exactly one reviewed native net.`
    );
  }
  return names[0]!;
};

const roundedHundredth = (value: number): number => Math.round(value * 100) / 100;

export const buildReferenceSchematicIntent = (
  profile: ReferenceControllerProfile,
  requirementsDigest: string,
  designRevisionId: string
) => {
  const logicRail = profile.rails.find((rail) => rail.name === "3V3");
  if (logicRail?.nominalMv === null || logicRail?.nominalMv === undefined) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE",
      "The Rev-A schematic intent requires a nominal 3V3 rail voltage."
    );
  }
  const vrefDivider = Object.freeze({
    topOhm: 3_240,
    bottomOhm: 10_000,
    filterCapacitanceNf: 100,
    sourceMv: logicRail.nominalMv
  });
  const requiredNetBindings =
    REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.schematicIntentRequiredSemanticNets.map(
      (semanticName) => ({
        semanticName,
        nativeNetNames: nativeArchitectureNetNames(semanticName)
      })
    );
  return {
    schemaVersion: CURRENT_SCHEMATIC_INTENT_SCHEMA,
    profileId: profile.profileId,
    boardRevision: profile.boardRevision,
    requirementsDigest,
    designRevisionId,
    lifecycle: "candidate",
    nativeContractBinding: {
      semanticIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
      contentIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
    },
    schematicStructure: {
      representation: "flat_root",
      rootSheetId: "root",
      nativeSheetCount: 1,
      functionalGroupsAreSheets: false
    },
    functionalGroups: [
      { name: "input_and_power", function: "protected battery input, buck, LDO, and switched sensor rail", nativeSheet: "root" },
      { name: "controller", function: "STM32G0B1CET6, SWD, reset, internal clocking, decoupling, and configurable board-ID straps", nativeSheet: "root" },
      { name: "motor_a", function: "DRV8874PWP channel A with current sense and current regulation", nativeSheet: "root" },
      { name: "motor_b", function: "DRV8874PWP channel B with current sense and current regulation", nativeSheet: "root" },
      { name: "communications", function: "protected USB, CAN, UART, I2C, and SPI", nativeSheet: "root" },
      { name: "sensors_and_expansion", function: "switched sensor rail, two encoder buffers, and 3.3 V expansion headers", nativeSheet: "root" }
    ],
    nativeImplementation: {
      inputOvercurrentProtection: {
        reference: "F1",
        implementation: "surface_mount_resettable_ptc",
        value: "3A PTC",
        footprint: "Fuse:Fuse_1812_4532Metric"
      },
      testPointDesignators: [] as readonly string[]
    },
    motorCurrentRegulation: {
      channels: profile.motor.channels,
      rmsOperatingTargetMa: profile.motor.rmsCurrentMaPerChannel,
      chopTargetMa: profile.motor.currentChopMaPerChannel,
      pwmFrequencyHz: 20_000,
      controlMode: "DRV8874 PH/EN",
      ipropiScalingUaPerA: 455,
      ipropiResistorOhm: 5_490,
      vrefTargetMv: roundedHundredth(
        (vrefDivider.sourceMv * vrefDivider.bottomOhm) /
          (vrefDivider.topOhm + vrefDivider.bottomOhm)
      ),
      vrefDivider,
      sourceBasis: "Rev-A native BOM and netlist values; tolerance and operating behavior still require source-bound analysis and bench verification"
    },
    canTermination: {
      resistanceOhm: 120,
      resistorReference: "R11",
      resistorPopulation: "fitted",
      enableJumperReference: "JP1",
      enableJumperImplementation: "normally_open_solder_jumper",
      defaultState: "open_disabled",
      nativeLineNets: [singleArchitectureNet("CANH"), singleArchitectureNet("CANL")]
    },
    requiredNetVocabulary: "native_kicad",
    requiredNetBindings,
    requiredNets: requiredNetBindings.flatMap((binding) => binding.nativeNetNames),
    pinAssignments: profile.pins.map((pin) => ({
      signal: pin.signal,
      nativeNetName: nativeSignalName(pin.signal),
      physicalPin: pin.physicalPin,
      mcuPin: pin.mcuPin,
      peripheral: pin.peripheral,
      direction: pin.direction,
      voltageDomain: pin.voltageDomain
    })),
    nativeResetNetwork: {
      populatedBiases: [
        { signal: "MOTOR_A_NSLEEP", nativeNetName: nativeSignalName("MOTOR_A_NSLEEP"), resistanceOhm: 100_000, bias: "pull_down_to_ground" },
        { signal: "MOTOR_B_NSLEEP", nativeNetName: nativeSignalName("MOTOR_B_NSLEEP"), resistanceOhm: 100_000, bias: "pull_down_to_ground" },
        { signal: "SENSOR_PWR_EN", nativeNetName: nativeSignalName("SENSOR_PWR_EN"), resistanceOhm: 100_000, bias: "pull_down_to_ground" },
        { signal: "CAN_STB", nativeNetName: nativeSignalName("CAN_STB"), resistanceOhm: 100_000, bias: "pull_up_to_3v3" }
      ],
      directUnbiasedMotorControls: [
        "MOTOR_A_PWM",
        "MOTOR_A_DIR",
        "MOTOR_B_PWM",
        "MOTOR_B_DIR"
      ].map((signal) => ({ signal, nativeNetName: nativeSignalName(signal) })),
      policy: "Do not infer external PWM/DIR biasing from legacy profile prose; firmware must keep nSLEEP asserted low until initialization and fault checks complete."
    },
    connectivityInvariants: [
      `USB VBUS may be protected and sensed but must not connect to ${singleArchitectureNet("5V0")}, ${singleArchitectureNet("3V3")}, or ${singleArchitectureNet("VBAT_PROTECTED")} as a power source.`,
      "Local decoupling and exposed-pad connections remain requirements to verify against native topology; this intent does not itself prove them.",
      "DRV8874 nFAULT, IPROPI, VREF, nSLEEP, PH, and EN/PWM are required for both independent channels.",
      `SWDIO, SWCLK, NRST, ${singleArchitectureNet("3V3")}, and ground are required on the programming connector.`,
      "The fitted 120-ohm CAN termination resistor is disabled by the normally-open JP1 series jumper until JP1 is closed.",
      "Encoder connector inputs pass through SN74LVC2G17 buffers before STM32 timer pins; the buffer outputs have no populated pull-downs.",
      "Sensor connector power comes only from TPS2553-1, with SENSOR_PWR_EN held low by a populated 100-kohm resistor."
    ],
    requiredChecks: ["KiCad ERC", "KiCad connectivity contract comparison"],
    nativeSourcePolicy: "Only the configured KiCad backend may produce .kicad_pro/.kicad_sch bytes or a native pass."
  };
};

export type ReferenceSchematicIntentV2 = ReturnType<typeof buildReferenceSchematicIntent>;

interface SnapshotBudget {
  nodes: number;
  scalarBytes: number;
}

const isArrayIndex = (key: string): boolean =>
  /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < 4_294_967_295;

const snapshotJson = (
  value: unknown,
  path: string,
  depth: number,
  budget: SnapshotBudget,
  seen: Set<object>
): unknown => {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
    return fail("REFERENCE_SCHEMATIC_INTENT_TOO_LARGE", "Schematic intent exceeds its structural limits.");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE", `${path} must be a finite number.`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      return fail("REFERENCE_SCHEMATIC_INTENT_TOO_LARGE", `${path} exceeds the string limit.`);
    }
    budget.scalarBytes += Buffer.byteLength(value, "utf8");
    if (budget.scalarBytes > REFERENCE_SCHEMATIC_INTENT_MAX_BYTES) {
      return fail("REFERENCE_SCHEMATIC_INTENT_TOO_LARGE", "Schematic intent exceeds its byte budget.");
    }
    return value;
  }
  if (typeof value !== "object" || value === undefined || nodeTypes.isProxy(value)) {
    return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE", `${path} is not plain JSON data.`);
  }
  if (seen.has(value)) {
    return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE", `${path} repeats an object or contains a cycle.`);
  }
  seen.add(value);
  {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) {
        return fail("REFERENCE_SCHEMATIC_INTENT_TOO_LARGE", `${path} exceeds the array limit.`);
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !isArrayIndex(key))
        )
      ) {
        return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE", `${path} has non-JSON array properties.`);
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE", `${path} must be a dense data array.`);
        }
        result.push(snapshotJson(descriptor.value, `${path}[${index}]`, depth + 1, budget, seen));
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE", `${path} must be a plain object.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_OBJECT_KEYS || keys.some((key) => typeof key !== "string")) {
      return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE", `${path} has invalid object keys.`);
    }
    for (const key of keys as string[]) {
      if (key === "__proto__") {
        return fail(
          "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE",
          `${path} may not contain an own __proto__ property.`
        );
      }
      if (key.length > MAX_STRING_LENGTH) {
        return fail("REFERENCE_SCHEMATIC_INTENT_TOO_LARGE", `${path} has an oversized key.`);
      }
      budget.scalarBytes += Buffer.byteLength(key, "utf8");
      if (budget.scalarBytes > REFERENCE_SCHEMATIC_INTENT_MAX_BYTES) {
        return fail("REFERENCE_SCHEMATIC_INTENT_TOO_LARGE", "Schematic intent exceeds its byte budget.");
      }
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of (keys as string[]).sort(compareText)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE", `${path}.${key} must be enumerable data.`);
      }
      Object.defineProperty(result, key, {
        value: snapshotJson(descriptor.value, `${path}.${key}`, depth + 1, budget, seen),
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    return Object.freeze(result);
  }
};

export interface ValidateReferenceSchematicIntentOptions {
  readonly profile: ReferenceControllerProfile;
  readonly requirementsDigest: string;
  readonly designRevisionId: string;
}

const snapshotCurrentIntent = (value: unknown): unknown => {
  const snapshot = snapshotJson(value, "schematicIntent", 0, { nodes: 0, scalarBytes: 0 }, new Set());
  const suppliedSchema =
    typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>).schemaVersion
      : undefined;
  if (suppliedSchema === LEGACY_SCHEMATIC_INTENT_SCHEMA) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_UPGRADE_REQUIRED",
      "Legacy schematic intent v1 requires an explicit schematic-stage rerun."
    );
  }
  if (suppliedSchema !== CURRENT_SCHEMATIC_INTENT_SCHEMA) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_UNSUPPORTED_SCHEMA",
      "Schematic intent does not use the current supported schema."
    );
  }
  let snapshotBytes: string;
  try {
    snapshotBytes = canonicalJson(snapshot);
  } catch {
    return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE", "Schematic intent cannot be canonically encoded.");
  }
  if (Buffer.byteLength(snapshotBytes, "utf8") > REFERENCE_SCHEMATIC_INTENT_MAX_BYTES) {
    return fail("REFERENCE_SCHEMATIC_INTENT_TOO_LARGE", "Schematic intent exceeds its canonical byte limit.");
  }
  return snapshot;
};

const currentRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT", `${name} is missing from the current intent.`);
  }
  return value as Record<string, unknown>;
};

const currentInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return fail("REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT", `${name} is not a current positive integer.`);
  }
  return value as number;
};

const requireExpectedIntent = (
  snapshot: unknown,
  expected: ReferenceSchematicIntentV2
): ReferenceSchematicIntentV2 => {
  if (canonicalJson(snapshot) !== canonicalJson(expected)) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT",
      "Schematic intent does not exactly match the current reviewed deterministic Rev-A intent."
    );
  }
  return snapshot as ReferenceSchematicIntentV2;
};

export const validateAndSnapshotReferenceSchematicIntentV2Shape = (
  value: unknown
): ReferenceSchematicIntentV2 => {
  const snapshot = snapshotCurrentIntent(value);
  const root = currentRecord(snapshot, "schematicIntent");
  const requirementsDigest = root.requirementsDigest;
  const designRevisionId = root.designRevisionId;
  if (typeof requirementsDigest !== "string" || !/^[0-9a-f]{64}$/u.test(requirementsDigest)) {
    return fail("REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT", "requirementsDigest is not an exact digest.");
  }
  if (
    typeof designRevisionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(designRevisionId)
  ) {
    return fail("REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT", "designRevisionId is not a safe identifier.");
  }
  const regulation = currentRecord(root.motorCurrentRegulation, "motorCurrentRegulation");
  const channels = currentInteger(regulation.channels, "motorCurrentRegulation.channels");
  const rmsOperatingTargetMa = currentInteger(
    regulation.rmsOperatingTargetMa,
    "motorCurrentRegulation.rmsOperatingTargetMa"
  );
  const chopTargetMa = currentInteger(
    regulation.chopTargetMa,
    "motorCurrentRegulation.chopTargetMa"
  );
  if (
    channels !== ROBOTICS_CONTROLLER_V0.motor.channels ||
    chopTargetMa !== ROBOTICS_CONTROLLER_V0.motor.currentChopMaPerChannel ||
    rmsOperatingTargetMa > ROBOTICS_CONTROLLER_V0.motor.rmsCurrentMaPerChannel
  ) {
    return fail("REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT", "Motor topology is outside current Rev-A shape.");
  }
  const shapeProfile: ReferenceControllerProfile = {
    ...ROBOTICS_CONTROLLER_V0,
    motor: {
      ...ROBOTICS_CONTROLLER_V0.motor,
      rmsCurrentMaPerChannel: rmsOperatingTargetMa
    }
  };
  return requireExpectedIntent(
    snapshot,
    buildReferenceSchematicIntent(shapeProfile, requirementsDigest, designRevisionId)
  );
};

export const validateAndSnapshotReferenceSchematicIntentV2 = (
  value: unknown,
  options: ValidateReferenceSchematicIntentOptions
): ReferenceSchematicIntentV2 => {
  const snapshot = validateAndSnapshotReferenceSchematicIntentV2Shape(value);
  return requireExpectedIntent(
    snapshot,
    buildReferenceSchematicIntent(
      options.profile,
      options.requirementsDigest,
      options.designRevisionId
    )
  );
};

export const parseAndValidateReferenceSchematicIntentV2Json = (
  source: string,
  options: ValidateReferenceSchematicIntentOptions
): ReferenceSchematicIntentV2 => {
  if (Buffer.byteLength(source, "utf8") > REFERENCE_SCHEMATIC_INTENT_MAX_BYTES) {
    return fail("REFERENCE_SCHEMATIC_INTENT_TOO_LARGE", "Schematic intent JSON exceeds its byte limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_JSON", "Schematic intent is not valid JSON.");
  }
  const snapshot = validateAndSnapshotReferenceSchematicIntentV2(value, options);
  if (source !== `${canonicalJson(snapshot)}\n`) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_NON_CANONICAL_JSON",
      "Schematic intent must be exact canonical JSON followed by one LF."
    );
  }
  return snapshot;
};

const snapshotContentIdentity = (value: unknown): Readonly<ContentIdentity> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_IDENTITY_INVALID",
      "Schematic intent content identity must be a closed plain object."
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_IDENTITY_INVALID",
      "Schematic intent content identity has an invalid prototype."
    );
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = ["algorithm", "digest", "size"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_IDENTITY_INVALID",
      "Schematic intent content identity has unknown or missing fields."
    );
  }
  const fields: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail(
        "REFERENCE_SCHEMATIC_INTENT_IDENTITY_INVALID",
        "Schematic intent content identity fields must be enumerable data."
      );
    }
    fields[key] = descriptor.value;
  }
  if (
    fields.algorithm !== "sha256" ||
    typeof fields.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(fields.digest) ||
    !Number.isSafeInteger(fields.size) ||
    (fields.size as number) < 1 ||
    (fields.size as number) > REFERENCE_SCHEMATIC_INTENT_MAX_BYTES
  ) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_IDENTITY_INVALID",
      "Schematic intent content identity values are invalid."
    );
  }
  return Object.freeze({
    algorithm: "sha256",
    digest: fields.digest,
    size: fields.size
  } as ContentIdentity);
};

export const parseAndValidateReferenceSchematicIntentV2Bytes = (
  bytes: Uint8Array,
  declaredIdentity: unknown,
  options: ValidateReferenceSchematicIntentOptions
): ReferenceSchematicIntentV2 => {
  if (nodeTypes.isProxy(bytes) || !nodeTypes.isUint8Array(bytes)) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_BYTES_INVALID",
      "Schematic intent content must be ordinary Uint8Array bytes."
    );
  }
  if (
    Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
    TYPED_ARRAY_BYTE_LENGTH === undefined ||
    TYPED_ARRAY_BUFFER === undefined
  ) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_BYTES_INVALID",
      "Schematic intent content must use the ordinary Uint8Array prototype."
    );
  }
  const byteLength = TYPED_ARRAY_BYTE_LENGTH.call(bytes) as number;
  if (byteLength > REFERENCE_SCHEMATIC_INTENT_MAX_BYTES) {
    return fail("REFERENCE_SCHEMATIC_INTENT_TOO_LARGE", "Schematic intent bytes exceed their limit.");
  }
  if (nodeTypes.isSharedArrayBuffer(TYPED_ARRAY_BUFFER.call(bytes))) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_BYTES_INVALID",
      "Schematic intent content may not use shared backing memory."
    );
  }
  const identity = snapshotContentIdentity(declaredIdentity);
  const copiedBytes = new Uint8Array(byteLength);
  UINT8_ARRAY_SET.call(copiedBytes, bytes);
  const actualIdentity = contentIdentity(copiedBytes);
  if (
    actualIdentity.algorithm !== identity.algorithm ||
    actualIdentity.digest !== identity.digest ||
    actualIdentity.size !== identity.size
  ) {
    return fail(
      "REFERENCE_SCHEMATIC_INTENT_IDENTITY_MISMATCH",
      "Schematic intent bytes do not reproduce the declared content identity."
    );
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copiedBytes);
  } catch {
    return fail("REFERENCE_SCHEMATIC_INTENT_INVALID_JSON", "Schematic intent is not fatal UTF-8 JSON.");
  }
  return parseAndValidateReferenceSchematicIntentV2Json(source, options);
};

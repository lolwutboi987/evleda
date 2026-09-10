import { describe, expect, it } from "vitest";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "../../src/knowledge/reference-controller-native-contract.js";
import {
  CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
  LEGACY_SYSTEM_ARCHITECTURE_SCHEMA,
  ReferenceSystemArchitectureError,
  buildReferenceSystemArchitecture,
  validateAndSnapshotReferenceSystemArchitectureV2Shape
} from "../../src/knowledge/reference-system-architecture.js";
import {
  ROBOTICS_CONTROLLER_V0,
  createReferenceControllerProfile
} from "../../src/knowledge/reference-controller-v0.js";

const baseArchitecture = () => buildReferenceSystemArchitecture(ROBOTICS_CONTROLLER_V0);
const mutable = (value: unknown): any => structuredClone(value);

const expectCode = (value: unknown, code: ReferenceSystemArchitectureError["code"]): void => {
  expect(() => validateAndSnapshotReferenceSystemArchitectureV2Shape(value)).toThrowError(
    expect.objectContaining({ code })
  );
};

describe("reference system architecture v2", () => {
  it("builds one deterministic, native-bound, active-low-safe Rev-A architecture", () => {
    const architecture = baseArchitecture();
    const snapshot = validateAndSnapshotReferenceSystemArchitectureV2Shape(architecture);

    expect(snapshot).toStrictEqual(architecture);
    expect(snapshot).not.toBe(architecture);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nativeNetBindings.signals)).toBe(true);
    expect(snapshot.nativeContractBinding).toStrictEqual({
      semanticIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
      contentIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
    });
    expect(snapshot.nativeNetBindings.architecture).toHaveLength(16);
    expect(snapshot.nativeNetBindings.signals).toHaveLength(37);
    expect(snapshot.nativeNetBindings.architecture).toStrictEqual(
      Object.keys(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases)
        .sort()
        .map((semanticName) => ({
          semanticName,
          nativeNetNames:
            REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases[semanticName]
        }))
    );
    expect(snapshot.nativeNetBindings.signals).toStrictEqual(
      Object.keys(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.signalAliases)
        .sort()
        .map((semanticName) => ({
          semanticName,
          nativeNetName: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.signalAliases[semanticName]
        }))
    );
    expect(snapshot.faultPolicy).toContain(
      "Watchdog, brownout, clock, board-ID, ADC, or firmware-contract mismatch must assert both nSLEEP controls low; native nSLEEP pull-downs provide fail-off bias only while their MCU pins are high impedance."
    );
    expect(canonicalJson(snapshot)).not.toContain("must deassert both nSLEEP");

    expect(contentIdentity(`${canonicalJson(snapshot)}\n`)).toStrictEqual({
      algorithm: "sha256",
      digest: "19f3005a2283de8f4e676b7cd5b1917406a6079257d498f3ede2c952aa0e652c",
      size: 12_534
    });
    expect(canonicalIdentity(snapshot, CURRENT_SYSTEM_ARCHITECTURE_SCHEMA)).toStrictEqual({
      algorithm: "sha256",
      digest: "4902f38aeae83eca5d462c08ed02df4a50e1ca7808fc78b8ea33c31a3a8c3cee",
      schemaVersion: CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
      canonicalizationVersion: "evleda-c14n-json-v1"
    });
  });

  it("accepts an exact supported Rev-A subset and gives it a distinct deterministic identity", () => {
    const profile = createReferenceControllerProfile({
      inputVoltageMv: { minimum: 8_000, maximum: 12_000 },
      motor: {
        channels: 2,
        rmsCurrentMaPerChannel: 250,
        currentChopMaPerChannel: 1_000
      }
    });
    const architecture = buildReferenceSystemArchitecture(profile);
    const first = validateAndSnapshotReferenceSystemArchitectureV2Shape(architecture);
    const second = validateAndSnapshotReferenceSystemArchitectureV2Shape(architecture);

    expect(first).toStrictEqual(architecture);
    expect(canonicalIdentity(first, CURRENT_SYSTEM_ARCHITECTURE_SCHEMA)).toStrictEqual(
      canonicalIdentity(second, CURRENT_SYSTEM_ARCHITECTURE_SCHEMA)
    );
    expect(contentIdentity(`${canonicalJson(first)}\n`)).toStrictEqual({
      algorithm: "sha256",
      digest: "2fcfbff54de14423ef146d73d2c460e6a92cb034d47095a3a130de13e218e496",
      size: 12_535
    });
    expect(canonicalIdentity(first, CURRENT_SYSTEM_ARCHITECTURE_SCHEMA).digest).not.toBe(
      canonicalIdentity(baseArchitecture(), CURRENT_SYSTEM_ARCHITECTURE_SCHEMA).digest
    );
  });

  it("keeps legacy v1 replay-only and rejects future, relabelled-minimal, missing, and unknown shapes", () => {
    expectCode(
      { ...baseArchitecture(), schemaVersion: LEGACY_SYSTEM_ARCHITECTURE_SCHEMA },
      "REFERENCE_SYSTEM_ARCHITECTURE_UPGRADE_REQUIRED"
    );
    expectCode(
      { ...baseArchitecture(), schemaVersion: "evleda.system-architecture.v3" },
      "REFERENCE_SYSTEM_ARCHITECTURE_UNSUPPORTED_SCHEMA"
    );
    expectCode(
      {
        schemaVersion: CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
        profileId: "robotics-controller-v0",
        functionalBlocks: [{ id: "protected_input" }]
      },
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT"
    );
    const { interfaces: _interfaces, ...missing } = baseArchitecture();
    expectCode(missing, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");
    expectCode(
      { ...baseArchitecture(), unreviewedField: "must-not-be-accepted" },
      "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT"
    );
    const prototypeNamedField = mutable(baseArchitecture());
    Object.defineProperty(prototypeNamedField, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { polluted: true }
    });
    expectCode(prototypeNamedField, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");
  });

  it("rejects either stale native identity and every incomplete or reordered binding set", () => {
    const staleSemantic = mutable(baseArchitecture());
    staleSemantic.nativeContractBinding.semanticIdentity.digest = "0".repeat(64);
    expectCode(staleSemantic, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");

    const staleContent = mutable(baseArchitecture());
    staleContent.nativeContractBinding.contentIdentity.digest = "0".repeat(64);
    expectCode(staleContent, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");

    const missingSignal = mutable(baseArchitecture());
    missingSignal.nativeNetBindings.signals.pop();
    expectCode(missingSignal, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");

    const reorderedArchitectureNets = mutable(baseArchitecture());
    [
      reorderedArchitectureNets.nativeNetBindings.architecture[0],
      reorderedArchitectureNets.nativeNetBindings.architecture[1]
    ] = [
      reorderedArchitectureNets.nativeNetBindings.architecture[1],
      reorderedArchitectureNets.nativeNetBindings.architecture[0]
    ];
    expectCode(reorderedArchitectureNets, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");

    const reorderedSignals = mutable(baseArchitecture());
    [reorderedSignals.nativeNetBindings.signals[0], reorderedSignals.nativeNetBindings.signals[1]] = [
      reorderedSignals.nativeNetBindings.signals[1],
      reorderedSignals.nativeNetBindings.signals[0]
    ];
    expectCode(reorderedSignals, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");

    const reorderedBlocks = mutable(baseArchitecture());
    [reorderedBlocks.functionalBlocks[0], reorderedBlocks.functionalBlocks[1]] = [
      reorderedBlocks.functionalBlocks[1],
      reorderedBlocks.functionalBlocks[0]
    ];
    expectCode(reorderedBlocks, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");
  });

  it("rejects out-of-envelope and internally inconsistent parameter variants", () => {
    const tooMuchCurrent = mutable(baseArchitecture());
    tooMuchCurrent.functionalBlocks[1].limits.rmsCurrentMaPerChannel = 501;
    expectCode(tooMuchCurrent, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");

    const badChop = mutable(baseArchitecture());
    badChop.functionalBlocks[1].limits.currentChopMaPerChannel = 999;
    expectCode(badChop, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");

    const outOfRangeVoltage = mutable(baseArchitecture());
    outOfRangeVoltage.powerRails[0].minimumMv = 6_999;
    expectCode(outOfRangeVoltage, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");

    const staleDerivedText = mutable(baseArchitecture());
    staleDerivedText.powerRails[0].minimumMv = 8_000;
    expectCode(staleDerivedText, "REFERENCE_SYSTEM_ARCHITECTURE_NOT_CURRENT");
  });

  it("rejects root and nested proxies without invoking their traps", () => {
    let rootCalls = 0;
    const rootProxy = new Proxy(baseArchitecture(), {
      get() {
        rootCalls += 1;
        throw new Error("proxy trap must not execute");
      }
    });
    expectCode(rootProxy, "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE");
    expect(rootCalls).toBe(0);

    let nestedCalls = 0;
    const nestedProxy = new Proxy(baseArchitecture().nativeContractBinding, {
      get() {
        nestedCalls += 1;
        throw new Error("nested proxy trap must not execute");
      }
    });
    expectCode(
      { ...baseArchitecture(), nativeContractBinding: nestedProxy },
      "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE"
    );
    expect(nestedCalls).toBe(0);
  });

  it("rejects root and nested accessors without invoking them", () => {
    let rootCalls = 0;
    const root = mutable(baseArchitecture());
    Object.defineProperty(root, "schemaVersion", {
      configurable: true,
      enumerable: true,
      get() {
        rootCalls += 1;
        throw new Error("root accessor must not execute");
      }
    });
    expectCode(root, "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE");
    expect(rootCalls).toBe(0);

    let nestedCalls = 0;
    const nested = mutable(baseArchitecture());
    Object.defineProperty(nested.functionalBlocks[1].limits, "rmsCurrentMaPerChannel", {
      configurable: true,
      enumerable: true,
      get() {
        nestedCalls += 1;
        throw new Error("nested accessor must not execute");
      }
    });
    expectCode(nested, "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE");
    expect(nestedCalls).toBe(0);
  });

  it("rejects cycles, repeated references, sparse/custom arrays, symbols, and exotic prototypes", () => {
    const cyclic = mutable(baseArchitecture());
    cyclic.cycle = cyclic;
    expectCode(cyclic, "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE");

    const repeated = mutable(baseArchitecture());
    repeated.repeatedBinding = repeated.nativeContractBinding;
    expectCode(repeated, "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE");

    const sparse = mutable(baseArchitecture());
    delete sparse.functionalBlocks[2];
    expectCode(sparse, "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE");

    const customArray = mutable(baseArchitecture());
    Object.defineProperty(customArray.interfaces, "extra", {
      configurable: true,
      enumerable: true,
      value: "forbidden"
    });
    expectCode(customArray, "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE");

    const symbol = mutable(baseArchitecture());
    Object.defineProperty(symbol, Symbol("forbidden"), {
      configurable: true,
      enumerable: true,
      value: true
    });
    expectCode(symbol, "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE");

    const exotic = mutable(baseArchitecture());
    Object.setPrototypeOf(exotic.nativeContractBinding, { inherited: true });
    expectCode(exotic, "REFERENCE_SYSTEM_ARCHITECTURE_INVALID_STRUCTURE");
  });

  it("enforces depth, array, object-key, key/string, and canonical-byte budgets", () => {
    let deep: any = "leaf";
    for (let index = 0; index < 18; index += 1) deep = { child: deep };
    expectCode(
      { ...baseArchitecture(), excessiveDepth: deep },
      "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE"
    );

    expectCode(
      { ...baseArchitecture(), excessiveArray: new Array(257).fill(null) },
      "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE"
    );

    const excessiveKeys: Record<string, null> = {};
    for (let index = 0; index < 257; index += 1) excessiveKeys[`key${index}`] = null;
    expectCode(
      { ...baseArchitecture(), excessiveKeys },
      "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE"
    );

    expectCode(
      { ...baseArchitecture(), oversizedString: "x".repeat(4_097) },
      "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE"
    );

    expectCode(
      { ...baseArchitecture(), ["k".repeat(4_097)]: true },
      "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE"
    );

    const aggregate = mutable(baseArchitecture());
    aggregate.aggregateStrings = new Array(20).fill("x".repeat(4_000));
    expectCode(aggregate, "REFERENCE_SYSTEM_ARCHITECTURE_TOO_LARGE");
  });
});

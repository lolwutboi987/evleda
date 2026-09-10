import { describe, expect, it } from "vitest";

import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "../../src/knowledge/reference-controller-native-contract.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import {
  CURRENT_SCHEMATIC_INTENT_SCHEMA,
  LEGACY_SCHEMATIC_INTENT_SCHEMA,
  REFERENCE_SCHEMATIC_INTENT_MAX_BYTES,
  ReferenceSchematicIntentError,
  type ReferenceSchematicIntentErrorCode,
  buildReferenceSchematicIntent,
  parseAndValidateReferenceSchematicIntentV2Bytes,
  validateAndSnapshotReferenceSchematicIntentV2
} from "../../src/knowledge/reference-schematic-intent.js";

const options = {
  profile: ROBOTICS_CONTROLLER_V0,
  requirementsDigest: "a".repeat(64),
  designRevisionId: "revision_schematic_intent_fixture"
};

const current = () => buildReferenceSchematicIntent(
  options.profile,
  options.requirementsDigest,
  options.designRevisionId
);

const expectCode = (
  action: () => unknown,
  code: ReferenceSchematicIntentErrorCode
): void => {
  expect(action).toThrowError(
    expect.objectContaining<Partial<ReferenceSchematicIntentError>>({ code })
  );
};

describe("reference schematic-intent v2 contract", () => {
  it("builds and snapshots only the exact current deterministic document", () => {
    const first = current();
    const second = current();
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(first).toMatchObject({
      schemaVersion: CURRENT_SCHEMATIC_INTENT_SCHEMA,
      nativeContractBinding: {
        semanticIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
        contentIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
      }
    });
    expect(first).not.toHaveProperty("hierarchicalSheets");
    expect(first).not.toHaveProperty("resetSafeRequirements");
    expect(first.requiredNetBindings.map((binding) => binding.semanticName)).toEqual(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.schematicIntentRequiredSemanticNets
    );
    for (const binding of first.requiredNetBindings) {
      expect(binding.nativeNetNames).toEqual(
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases[
          binding.semanticName
        ]
      );
    }

    const snapshot = validateAndSnapshotReferenceSchematicIntentV2(first, options);
    expect(canonicalJson(snapshot)).toBe(canonicalJson(first));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.requiredNetBindings)).toBe(true);
    expect(Object.isFrozen(snapshot.nativeContractBinding.semanticIdentity)).toBe(true);
  });

  it("does not upcast v1, future, minimal, mixed, reordered, or stale-contract documents", () => {
    const legacy = { ...current(), schemaVersion: LEGACY_SCHEMATIC_INTENT_SCHEMA };
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(legacy, options),
      "REFERENCE_SCHEMATIC_INTENT_UPGRADE_REQUIRED"
    );

    const future = { ...current(), schemaVersion: "evleda.schematic-intent.v3" };
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(future, options),
      "REFERENCE_SCHEMATIC_INTENT_UNSUPPORTED_SCHEMA"
    );

    const minimal = { schemaVersion: CURRENT_SCHEMATIC_INTENT_SCHEMA };
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(minimal, options),
      "REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT"
    );

    const mixed = { ...current(), hierarchicalSheets: [{ name: "root" }] };
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(mixed, options),
      "REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT"
    );

    const reordered = structuredClone(current());
    reordered.requiredNetBindings.reverse();
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(reordered, options),
      "REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT"
    );

    const stale = structuredClone(current());
    (stale.nativeContractBinding.semanticIdentity as { digest: string }).digest =
      "b".repeat(64);
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(stale, options),
      "REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT"
    );

    const outOfEnvelope = structuredClone(current());
    outOfEnvelope.motorCurrentRegulation.rmsOperatingTargetMa =
      ROBOTICS_CONTROLLER_V0.motor.rmsCurrentMaPerChannel + 1;
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(outOfEnvelope, options),
      "REFERENCE_SCHEMATIC_INTENT_NOT_CURRENT"
    );
  });

  it("rejects hostile object graphs without invoking proxy or accessor code", () => {
    let trapCalls = 0;
    const proxy = new Proxy(current(), {
      get() {
        trapCalls += 1;
        throw new Error("must not execute");
      },
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error("must not execute");
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error("must not execute");
      }
    });
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(proxy, options),
      "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE"
    );
    expect(trapCalls).toBe(0);

    let getterCalls = 0;
    const accessor = structuredClone(current()) as Record<string, unknown>;
    Object.defineProperty(accessor, "schemaVersion", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return CURRENT_SCHEMATIC_INTENT_SCHEMA;
      }
    });
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(accessor, options),
      "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE"
    );
    expect(getterCalls).toBe(0);

    for (const protoValue of [null, false, 0, "primitive"] as const) {
      const ownProto = structuredClone(current()) as Record<string, unknown>;
      Object.defineProperty(ownProto, "__proto__", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: protoValue
      });
      expectCode(
        () => validateAndSnapshotReferenceSchematicIntentV2(ownProto, options),
        "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE"
      );
    }

    let protoGetterCalls = 0;
    const accessorProto = structuredClone(current()) as Record<string, unknown>;
    Object.defineProperty(accessorProto, "__proto__", {
      enumerable: true,
      configurable: true,
      get() {
        protoGetterCalls += 1;
        return "must not read";
      }
    });
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(accessorProto, options),
      "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE"
    );
    expect(protoGetterCalls).toBe(0);

    const cyclic = structuredClone(current()) as Record<string, unknown>;
    cyclic.cycle = cyclic;
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(cyclic, options),
      "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE"
    );

    const repeated = structuredClone(current());
    (repeated.functionalGroups as unknown as Array<(typeof repeated.functionalGroups)[number]>)[1] =
      repeated.functionalGroups[0]!;
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(repeated, options),
      "REFERENCE_SCHEMATIC_INTENT_INVALID_STRUCTURE"
    );

    const oversized = { ...current(), oversized: "x".repeat(4_097) };
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(oversized, options),
      "REFERENCE_SCHEMATIC_INTENT_TOO_LARGE"
    );

    const oversizedKey = {
      ...current(),
      ["k".repeat(4_097)]: true
    };
    expectCode(
      () => validateAndSnapshotReferenceSchematicIntentV2(oversizedKey, options),
      "REFERENCE_SCHEMATIC_INTENT_TOO_LARGE"
    );
  });

  it("requires reproduced identity, fatal UTF-8, and exact canonical bytes", () => {
    const source = `${canonicalJson(current())}\n`;
    const bytes = new TextEncoder().encode(source);
    expect(
      parseAndValidateReferenceSchematicIntentV2Bytes(bytes, contentIdentity(bytes), options)
    ).toEqual(current());

    expectCode(
      () =>
        parseAndValidateReferenceSchematicIntentV2Bytes(
          bytes,
          contentIdentity("different"),
          options
        ),
      "REFERENCE_SCHEMATIC_INTENT_IDENTITY_MISMATCH"
    );

    let identityTrapCalls = 0;
    const proxyIdentity = new Proxy(contentIdentity(bytes), {
      get() {
        identityTrapCalls += 1;
        throw new Error("must not execute");
      },
      ownKeys() {
        identityTrapCalls += 1;
        throw new Error("must not execute");
      }
    });
    expectCode(
      () => parseAndValidateReferenceSchematicIntentV2Bytes(bytes, proxyIdentity, options),
      "REFERENCE_SCHEMATIC_INTENT_IDENTITY_INVALID"
    );
    expect(identityTrapCalls).toBe(0);

    let identityGetterCalls = 0;
    const accessorIdentity = { ...contentIdentity(bytes) } as Record<string, unknown>;
    Object.defineProperty(accessorIdentity, "digest", {
      enumerable: true,
      get() {
        identityGetterCalls += 1;
        return "a".repeat(64);
      }
    });
    expectCode(
      () => parseAndValidateReferenceSchematicIntentV2Bytes(bytes, accessorIdentity, options),
      "REFERENCE_SCHEMATIC_INTENT_IDENTITY_INVALID"
    );
    expect(identityGetterCalls).toBe(0);

    const oversizedBytes = new Uint8Array(REFERENCE_SCHEMATIC_INTENT_MAX_BYTES + 1);
    expectCode(
      () =>
        parseAndValidateReferenceSchematicIntentV2Bytes(
          oversizedBytes,
          { algorithm: "sha256", digest: "0".repeat(64), size: oversizedBytes.byteLength },
          options
        ),
      "REFERENCE_SCHEMATIC_INTENT_TOO_LARGE"
    );

    let byteTrapCalls = 0;
    const proxiedBytes = new Proxy(bytes, {
      get() {
        byteTrapCalls += 1;
        throw new Error("must not execute");
      },
      getPrototypeOf() {
        byteTrapCalls += 1;
        throw new Error("must not execute");
      }
    });
    expectCode(
      () =>
        parseAndValidateReferenceSchematicIntentV2Bytes(
          proxiedBytes,
          contentIdentity(bytes),
          options
        ),
      "REFERENCE_SCHEMATIC_INTENT_BYTES_INVALID"
    );
    expect(byteTrapCalls).toBe(0);

    const sharedBytes = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
    expectCode(
      () =>
        parseAndValidateReferenceSchematicIntentV2Bytes(
          sharedBytes,
          contentIdentity(sharedBytes),
          options
        ),
      "REFERENCE_SCHEMATIC_INTENT_BYTES_INVALID"
    );

    const nonCanonical = new TextEncoder().encode(JSON.stringify(current(), null, 2));
    expectCode(
      () =>
        parseAndValidateReferenceSchematicIntentV2Bytes(
          nonCanonical,
          contentIdentity(nonCanonical),
          options
        ),
      "REFERENCE_SCHEMATIC_INTENT_NON_CANONICAL_JSON"
    );

    const duplicateSource = source.replace(
      "{",
      `{"schemaVersion":"${CURRENT_SCHEMATIC_INTENT_SCHEMA}",`
    );
    const duplicate = new TextEncoder().encode(duplicateSource);
    expectCode(
      () =>
        parseAndValidateReferenceSchematicIntentV2Bytes(
          duplicate,
          contentIdentity(duplicate),
          options
        ),
      "REFERENCE_SCHEMATIC_INTENT_NON_CANONICAL_JSON"
    );

    const invalidUtf8 = Uint8Array.from([0xff, 0xfe]);
    expectCode(
      () =>
        parseAndValidateReferenceSchematicIntentV2Bytes(
          invalidUtf8,
          contentIdentity(invalidUtf8),
          options
        ),
      "REFERENCE_SCHEMATIC_INTENT_INVALID_JSON"
    );

    const bomPrefixed = new TextEncoder().encode(`\uFEFF${source}`);
    expectCode(
      () =>
        parseAndValidateReferenceSchematicIntentV2Bytes(
          bomPrefixed,
          contentIdentity(bomPrefixed),
          options
        ),
      "REFERENCE_SCHEMATIC_INTENT_INVALID_JSON"
    );
  });
});

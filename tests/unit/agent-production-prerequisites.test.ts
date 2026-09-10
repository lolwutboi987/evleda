import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import {
  PCB_ENGINEERING_PRACTICE_CATALOG
} from "../../src/knowledge/pcb-engineering-practices.js";
import {
  DESIGN_AGENT_CATALOG_LOGICAL_NAME,
  DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
  DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME,
  DESIGN_AGENT_PROMPT_PACK_SCHEMA,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
  DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
  DESIGN_AGENT_PROVIDER_SCHEMA,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
  type DesignAgentPort,
  type DesignAgentProviderRequest,
  type DesignAgentReplayReceipt,
  type DesignAgentTrustManifest
} from "../../src/agents/contracts.js";
import {
  DesignAgentCoordinator,
  bindDesignAgentModel,
  bindDesignAgentProvider,
  bindDesignAgentTrustManifest
} from "../../src/agents/coordinator.js";
import {
  createFileBackedDesignAgentTrustStore,
  designAgentTrustManifestCanonicalBytes,
  designAgentTrustManifestFileIdentity,
  type DesignAgentTrustManifestExpectedBindings,
  type FileBackedDesignAgentTrustStoreOptions
} from "../../src/agents/production-trust-store.js";
import {
  DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME,
  DESIGN_AGENT_DURABLE_RECEIPT_HEAD_NAME,
  DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA,
  DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORD_BYTES,
  createDurableDesignAgentReplayReceiptStore,
  scanDurableDesignAgentReplayReceiptStore
} from "../../src/agents/replay-receipt-store.js";
import {
  createApprovedDesignAgentProviderAdapterRegistry,
  designAgentProviderAdapterImplementationVersion,
  type DesignAgentProviderAdapterRegistration,
  type DesignAgentProviderAdapterSelection
} from "../../src/agents/provider-adapter-registry.js";
import { createDesignAgentProductionHost } from "../../src/agents/production-host.js";
import {
  arrayDataValues,
  copyBoundedOrdinaryUint8Array,
  plainDataProperties
} from "../../src/agents/production-boundary.js";

const MODEL_SOURCE = Object.freeze({
  provider: "fixture-provider",
  model: "fixture-model-1",
  version: "fixture-model-1-2026-09-05"
});
const PROVIDER_ADAPTER_BYTES = Buffer.from(
  "export const adapterBuild = 'fixture-2026-09-05';\n"
);
const PROVIDER_ADAPTER_IDENTITY = contentIdentity(PROVIDER_ADAPTER_BYTES);
const PROVIDER_SOURCE = Object.freeze({
  providerId: "fixture-provider",
  implementationVersion: designAgentProviderAdapterImplementationVersion(
    "fixture-adapter",
    PROVIDER_ADAPTER_IDENTITY,
    [MODEL_SOURCE]
  )
});
const PROVIDER = bindDesignAgentProvider(PROVIDER_SOURCE);
const MODEL = bindDesignAgentModel(MODEL_SOURCE);
const INSTRUCTION_BYTES = Buffer.from(
  "Fixture production instruction bytes. Proposals have no validation or release authority.\n",
  "utf8"
);
const RECEIPT_INTEGRITY_KEY = Buffer.alloc(32, 0x5a);
const receiptStoreOptions = (directoryPath: string) => ({
  directoryPath,
  storeId: "fixture-receipt-store",
  integrityKeyId: "fixture-key-2026-09-05",
  integrityKey: Buffer.from(RECEIPT_INTEGRITY_KEY)
});

const makeManifest = (): DesignAgentTrustManifest => bindDesignAgentTrustManifest({
  manifestId: "fixture-production-manifest",
  instructions: [{
    anchor: "instruction-current",
    logicalName: DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
    identity: contentIdentity(INSTRUCTION_BYTES)
  }],
  practiceCatalogs: [{
    anchor: "catalog-current",
    logicalName: DESIGN_AGENT_CATALOG_LOGICAL_NAME,
    identity: PCB_ENGINEERING_PRACTICE_CATALOG.identity
  }],
  providers: [{
    anchor: "provider-current",
    providerId: PROVIDER.providerId,
    identity: PROVIDER.identity
  }],
  modelFamilies: [{
    anchor: "model-family-current",
    providerAnchor: "provider-current",
    family: "fixture-family",
    modelIds: [MODEL.model]
  }],
  outputContracts: [{
    anchor: "proposal-output-v2",
    logicalName: DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME,
    bytesIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
    canonicalIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY
  }]
});

const expectedBindings = () => ({
  manifestId: "fixture-production-manifest",
  instructions: [{ anchor: "instruction-current", bytes: Buffer.from(INSTRUCTION_BYTES) }],
  practiceCatalogs: [{ anchor: "catalog-current", catalog: PCB_ENGINEERING_PRACTICE_CATALOG }],
  providers: [{ anchor: "provider-current", provider: { ...PROVIDER_SOURCE } }],
  modelFamilies: [{
    anchor: "model-family-current",
    providerAnchor: "provider-current",
    family: "fixture-family",
    models: [{ ...MODEL_SOURCE }]
  }],
  outputContractAnchors: ["proposal-output-v2"]
});

const writeManifestFixture = async (
  root: string,
  bytes = designAgentTrustManifestCanonicalBytes(makeManifest())
): Promise<FileBackedDesignAgentTrustStoreOptions> => {
  const manifestPath = path.join(root, "design-agent-trust-manifest.json");
  await writeFile(manifestPath, bytes, { flag: "wx" });
  return {
    manifestPath,
    expectedContentIdentity: contentIdentity(bytes),
    expectedBindings: expectedBindings()
  };
};

const makeReceipt = (
  suffix: string,
  overrides: Partial<Pick<
    DesignAgentReplayReceipt,
    "trustManifestIdentity" | "providerIdentity" | "promptPackIdentity"
  >> = {}
): DesignAgentReplayReceipt => {
  const replayIdentity = canonicalIdentity({ suffix }, DESIGN_AGENT_REPLAY_SCHEMA);
  const payload = {
    schemaVersion: DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
    receiptId: `replay_${replayIdentity.digest}`,
    replayIdentity,
    trustManifestIdentity:
      overrides.trustManifestIdentity ?? canonicalIdentity(
        { manifest: "fixture" },
        DESIGN_AGENT_TRUST_MANIFEST_SCHEMA
      ),
    providerIdentity:
      overrides.providerIdentity ?? canonicalIdentity(
        { provider: "fixture" },
        DESIGN_AGENT_PROVIDER_SCHEMA
      ),
    promptPackIdentity:
      overrides.promptPackIdentity ?? canonicalIdentity(
        { promptPack: suffix },
        DESIGN_AGENT_PROMPT_PACK_SCHEMA
      )
  };
  return {
    ...payload,
    identity: canonicalIdentity(payload, DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA)
  };
};

const deeplyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => !("value" in descriptor) || deeplyFrozen(descriptor.value, seen)
  );
};

describe("production boundary snapshots", () => {
  it("copies only bounded own enumerable JSON data without reading hidden or symbol metadata", () => {
    const source = Object.create(null) as Record<PropertyKey, unknown>;
    let hiddenReads = 0;
    Object.defineProperty(source, "kept", { enumerable: true, value: "value" });
    Object.defineProperty(source, "hidden", {
      enumerable: false,
      get: () => {
        hiddenReads += 1;
        return "hidden";
      }
    });
    Object.defineProperty(source, Symbol("metadata"), {
      enumerable: true,
      get: () => {
        hiddenReads += 1;
        return "symbol"
      }
    });
    Object.defineProperty(source, "unknown", {
      enumerable: true,
      get: () => {
        hiddenReads += 1;
        return "unknown"
      }
    });
    const ownKeys = vi.spyOn(Reflect, "ownKeys");
    const allDescriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
    try {
      const descriptors = plainDataProperties(
        source,
        ["kept"],
        "FIXTURE_BOUNDARY_INVALID",
        "fixture"
      );
      const snapshot = { kept: descriptors.kept!.value };
      expect(snapshot).toEqual({ kept: "value" });
      expect(hiddenReads).toBe(0);
      expect(ownKeys).not.toHaveBeenCalled();
      expect(allDescriptors.mock.calls.some(([candidate]) => candidate === source)).toBe(false);
    } finally {
      ownKeys.mockRestore();
      allDescriptors.mockRestore();
    }
  });

  it("allowlists fields without enumerating huge unknown maps and bounds sparse arrays by length", () => {
    const enormous = Object.create(null) as Record<string, unknown>;
    enormous.kept = "value";
    for (let index = 0; index < 20_000; index += 1) enormous[`key_${index}`] = index;
    const ownKeys = vi.spyOn(Reflect, "ownKeys");
    const allDescriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
    try {
      const descriptors = plainDataProperties(
        enormous,
        ["kept"],
        "FIXTURE_BOUNDARY_LIMIT",
        "enormous"
      );
      expect(descriptors.kept!.value).toBe("value");
      expect(ownKeys).not.toHaveBeenCalled();
      expect(allDescriptors.mock.calls.some(([candidate]) => candidate === enormous)).toBe(false);
    } finally {
      ownKeys.mockRestore();
      allDescriptors.mockRestore();
    }

    const sparse: unknown[] = [];
    sparse.length = 10_000_000;
    expect(() => arrayDataValues(
      sparse,
      16,
      "FIXTURE_ARRAY_LIMIT",
      "sparse",
      true
    )).toThrowError(
      expect.objectContaining({ failureCode: "FIXTURE_ARRAY_LIMIT" })
    );
  });

  it("uses typed-array intrinsics and rejects subclasses, shared storage, and detached buffers", () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    let ambientReads = 0;
    Object.defineProperty(source, "buffer", {
      configurable: true,
      get: () => {
        ambientReads += 1;
        throw new Error("instance buffer getter must not run");
      }
    });
    Object.defineProperty(source, "byteLength", {
      configurable: true,
      get: () => {
        ambientReads += 1;
        throw new Error("instance byteLength getter must not run");
      }
    });
    Object.defineProperty(source, "byteOffset", {
      configurable: true,
      get: () => {
        ambientReads += 1;
        throw new Error("instance byteOffset getter must not run");
      }
    });
    Object.defineProperty(source, Symbol.iterator, {
      configurable: true,
      get: () => {
        ambientReads += 1;
        throw new Error("iterator must not run");
      }
    });
    expect([...copyBoundedOrdinaryUint8Array(
      source,
      1,
      16,
      "FIXTURE_BYTES_INVALID",
      "bytes"
    )]).toEqual([1, 2, 3, 4]);
    expect(ambientReads).toBe(0);

    class DerivedBytes extends Uint8Array {}
    expect(() => copyBoundedOrdinaryUint8Array(
      new DerivedBytes(4),
      1,
      16,
      "FIXTURE_BYTES_INVALID",
      "bytes"
    )).toThrowError(expect.objectContaining({ failureCode: "FIXTURE_BYTES_INVALID" }));

    const shared = new Uint8Array(new SharedArrayBuffer(4));
    expect(() => copyBoundedOrdinaryUint8Array(
      shared,
      1,
      16,
      "FIXTURE_BYTES_INVALID",
      "bytes"
    )).toThrowError(expect.objectContaining({ failureCode: "FIXTURE_BYTES_INVALID" }));

    const detached = new Uint8Array(4);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => copyBoundedOrdinaryUint8Array(
      detached,
      0,
      16,
      "FIXTURE_BYTES_INVALID",
      "bytes"
    )).toThrowError(expect.objectContaining({ failureCode: "FIXTURE_BYTES_INVALID" }));
  });
});

describe("file-backed authenticated design-agent trust store", () => {
  const roots: string[] = [];

  const temporaryRoot = async (): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-agent-trust-"));
    roots.push(root);
    return root;
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }));
  });

  it("loads only exact canonical bytes and immutable independently reconstructed anchors", async () => {
    const root = await temporaryRoot();
    const options = await writeManifestFixture(root);
    const mutableInstruction = options.expectedBindings.instructions[0]!.bytes as Buffer;
    const pending = createFileBackedDesignAgentTrustStore(options);
    mutableInstruction.fill(0x78);
    (options as { manifestPath: string }).manifestPath = path.join(root, "changed.json");

    const store = await pending;
    const resolved = store.resolve("fixture-production-manifest");
    expect(store.authority).toBe("authenticated_production");
    expect(Object.isFrozen(store)).toBe(true);
    expect(deeplyFrozen(resolved)).toBe(true);
    expect(resolved).toStrictEqual(makeManifest());
    expect(store.resolve("absent-manifest")).toBeUndefined();
  });

  it("rejects file-byte, canonical-encoding, schema, and independently reconstructed anchor drift", async () => {
    const mismatchRoot = await temporaryRoot();
    const mismatchOptions = await writeManifestFixture(mismatchRoot);
    (mismatchOptions as unknown as { expectedContentIdentity: ReturnType<typeof contentIdentity> })
      .expectedContentIdentity = contentIdentity("different");
    await expect(createFileBackedDesignAgentTrustStore(mismatchOptions)).rejects.toMatchObject({
      failureCode: "AGENT_TRUST_MANIFEST_CONTENT_MISMATCH"
    });

    const noncanonicalRoot = await temporaryRoot();
    const noncanonicalBytes = Buffer.from(JSON.stringify(makeManifest()), "utf8");
    const noncanonicalOptions = await writeManifestFixture(noncanonicalRoot, noncanonicalBytes);
    await expect(createFileBackedDesignAgentTrustStore(noncanonicalOptions)).rejects.toMatchObject({
      failureCode: "AGENT_TRUST_MANIFEST_NOT_CANONICAL"
    });

    const schemaRoot = await temporaryRoot();
    const future = { ...makeManifest(), schemaVersion: "evleda.design-agent-trust-manifest.v999" };
    const futureBytes = Buffer.from(`${canonicalJson(future)}\n`, "utf8");
    const schemaOptions = await writeManifestFixture(schemaRoot, futureBytes);
    await expect(createFileBackedDesignAgentTrustStore(schemaOptions)).rejects.toMatchObject({
      failureCode: "AGENT_TRUST_MANIFEST_SCHEMA_UNSUPPORTED"
    });

    const anchorRoot = await temporaryRoot();
    const anchorOptions = await writeManifestFixture(anchorRoot);
    (anchorOptions.expectedBindings.instructions[0] as unknown as { bytes: Uint8Array }).bytes =
      Buffer.from("changed");
    await expect(createFileBackedDesignAgentTrustStore(anchorOptions)).rejects.toMatchObject({
      failureCode: "AGENT_TRUST_MANIFEST_BINDING_MISMATCH"
    });
  });

  it("rejects relative files, directories, and symbolic-link path aliases", async (context) => {
    await expect(createFileBackedDesignAgentTrustStore({
      manifestPath: "relative/trust.json",
      expectedContentIdentity: contentIdentity(""),
      expectedBindings: expectedBindings()
    })).rejects.toMatchObject({ failureCode: "AGENT_PRODUCTION_TRUST_STORE_INVALID" });

    const directoryRoot = await temporaryRoot();
    await expect(createFileBackedDesignAgentTrustStore({
      manifestPath: directoryRoot,
      expectedContentIdentity: contentIdentity(""),
      expectedBindings: expectedBindings()
    })).rejects.toMatchObject({ failureCode: "AGENT_PRODUCTION_TRUST_STORE_INVALID" });

    const symlinkRoot = await temporaryRoot();
    const options = await writeManifestFixture(symlinkRoot);
    const aliasParent = await temporaryRoot();
    const aliasDirectory = path.join(aliasParent, "manifest-root-alias");
    try {
      await symlink(symlinkRoot, aliasDirectory, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(createFileBackedDesignAgentTrustStore({
      ...options,
      manifestPath: path.join(aliasDirectory, path.basename(options.manifestPath))
    })).rejects.toMatchObject({ failureCode: "AGENT_PRODUCTION_TRUST_STORE_INVALID" });
  });

  it("rejects proxied instruction byte views without invoking proxy traps", async () => {
    const root = await temporaryRoot();
    const options = await writeManifestFixture(root);
    let trapReads = 0;
    const bytes = new Proxy(new Uint8Array(INSTRUCTION_BYTES), {
      get: (target, property, receiver) => {
        trapReads += 1;
        return Reflect.get(target, property, receiver);
      },
      getPrototypeOf: (target) => {
        trapReads += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    (options.expectedBindings.instructions[0] as unknown as { bytes: Uint8Array }).bytes = bytes;
    await expect(createFileBackedDesignAgentTrustStore(options)).rejects.toMatchObject({
      failureCode: "AGENT_PRODUCTION_TRUST_STORE_INVALID"
    });
    expect(trapReads).toBe(0);
  });

  it("requires exact catalog, provider, model, and output-contract anchor inventories", async () => {
    const baseline = expectedBindings();
    const variants = [
      {
        ...baseline,
        practiceCatalogs: [{
          anchor: "different-catalog-anchor",
          catalog: PCB_ENGINEERING_PRACTICE_CATALOG
        }]
      },
      {
        ...baseline,
        providers: [{
          anchor: "provider-current",
          provider: { ...PROVIDER_SOURCE, implementationVersion: "different-provider-build" }
        }]
      },
      {
        ...baseline,
        modelFamilies: [{
          anchor: "model-family-current",
          providerAnchor: "provider-current",
          family: "fixture-family",
          models: [{ ...MODEL_SOURCE, model: "different-model" }]
        }]
      },
      {
        ...baseline,
        outputContractAnchors: ["different-output-contract-anchor"]
      }
    ];
    for (const expected of variants) {
      const root = await temporaryRoot();
      const manifest = makeManifest();
      const bytes = designAgentTrustManifestCanonicalBytes(manifest);
      const manifestPath = path.join(root, "manifest.json");
      await writeFile(manifestPath, bytes, { flag: "wx" });
      await expect(createFileBackedDesignAgentTrustStore({
        manifestPath,
        expectedContentIdentity: designAgentTrustManifestFileIdentity(manifest),
        expectedBindings: expected
      })).rejects.toMatchObject({ failureCode: "AGENT_TRUST_MANIFEST_BINDING_MISMATCH" });
    }
  });

  it("rejects different versions of one provider/model ID across trust-family anchors", async () => {
    const root = await temporaryRoot();
    const options = await writeManifestFixture(root);
    const baseline = expectedBindings();
    const ambiguousBindings: DesignAgentTrustManifestExpectedBindings = {
      ...baseline,
      modelFamilies: [
        ...baseline.modelFamilies,
        {
          anchor: "model-family-second",
          providerAnchor: "provider-current",
          family: "fixture-family-second",
          models: [{ ...MODEL_SOURCE, version: "different-version-same-model-id" }]
        }
      ]
    };
    (options as unknown as {
      expectedBindings: DesignAgentTrustManifestExpectedBindings;
    }).expectedBindings = ambiguousBindings;
    await expect(createFileBackedDesignAgentTrustStore(options)).rejects.toMatchObject({
      failureCode: "AGENT_PRODUCTION_MODEL_VERSION_AMBIGUOUS",
      code: "POLICY_DENIED"
    });
  });
});

describe("durable append-only design-agent replay receipt store", () => {
  const roots: string[] = [];

  const temporaryRoot = async (): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-agent-receipts-"));
    roots.push(root);
    return root;
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }));
  });

  it("survives restart, treats an identical duplicate as a replay, and stores no request authority", async () => {
    const root = await temporaryRoot();
    const receipt = makeReceipt("restart");
    const mutableOptions = receiptStoreOptions(root);
    const pendingStore = createDurableDesignAgentReplayReceiptStore(mutableOptions);
    mutableOptions.integrityKey.fill(0x00);
    const first = await pendingStore;
    await first.append(receipt);
    await first.append(structuredClone(receipt));

    const restarted = await createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(root));
    expect(await restarted.resolve(receipt.receiptId)).toStrictEqual(receipt);
    expect(deeplyFrozen(await restarted.resolve(receipt.receiptId))).toBe(true);
    const report = await scanDurableDesignAgentReplayReceiptStore(receiptStoreOptions(root));
    expect(report.recordCount).toBe(1);
    expect(report.rollbackBoundary).toBe(
      "external_monotonic_root_required_for_historical_snapshot_rollback"
    );

    const recordsPath = path.join(root, DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME);
    const names = await readdir(recordsPath);
    expect(names).toEqual([`${receipt.receiptId}.json`]);
    const record = JSON.parse(await readFile(path.join(recordsPath, names[0]!), "utf8")) as object;
    expect(Object.keys(record).sort()).toEqual([
      "authentication",
      "identity",
      "previousRecordIdentity",
      "promptPackIdentity",
      "providerIdentity",
      "receipt",
      "receiptContentIdentity",
      "replayIdentity",
      "schemaVersion",
      "sequence",
      "storeId",
      "trustManifestIdentity"
    ]);
    expect(record).not.toHaveProperty("request");
    expect(record).not.toHaveProperty("authority");
    expect((record as { receipt: object }).receipt).not.toHaveProperty("authority");
    expect(Object.isFrozen(restarted)).toBe(true);
    expect(restarted.authority).toBe("durable_append_only_production");
  });

  it("allowlists receipt authority without enumerating huge unknown, hidden, or symbol metadata", async () => {
    const root = await temporaryRoot();
    const receipt = makeReceipt("allowlisted-receipt");
    const decorated = Object.create(null) as Record<PropertyKey, unknown>;
    for (const [key, value] of Object.entries(receipt)) {
      Object.defineProperty(decorated, key, { enumerable: true, value });
    }
    for (let index = 0; index < 20_000; index += 1) {
      Object.defineProperty(decorated, `unknown_${index}`, { enumerable: true, value: index });
    }
    let metadataReads = 0;
    Object.defineProperty(decorated, "hiddenAuthority", {
      enumerable: false,
      get: () => {
        metadataReads += 1;
        return "approved"
      }
    });
    Object.defineProperty(decorated, Symbol("authority"), {
      enumerable: true,
      get: () => {
        metadataReads += 1;
        return "approved"
      }
    });

    const store = await createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(root));
    await store.append(decorated as unknown as DesignAgentReplayReceipt);
    expect(metadataReads).toBe(0);
    expect(await store.resolve(receipt.receiptId)).toStrictEqual(receipt);
  });

  it("serializes concurrent initialization and appends across independent store instances", async () => {
    const root = await temporaryRoot();
    const stores = await Promise.all(Array.from({ length: 4 }, async () =>
      await createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(root))
    ));
    const receipts = Array.from({ length: 24 }, (_, index) => makeReceipt(`concurrent-${index}`));
    await Promise.all(receipts.flatMap((receipt, index) => [
      stores[index % stores.length]!.append(structuredClone(receipt)),
      stores[(index + 1) % stores.length]!.append(structuredClone(receipt))
    ]));

    const report = await scanDurableDesignAgentReplayReceiptStore(receiptStoreOptions(root));
    expect(report.recordCount).toBe(receipts.length);
    await expect(stores[0]!.resolve(receipts[17]!.receiptId)).resolves.toStrictEqual(receipts[17]);
  });

  it("rejects a conflicting duplicate ID and detects durable record tampering on restart", async () => {
    const root = await temporaryRoot();
    const receipt = makeReceipt("conflict");
    const store = await createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(root));
    await store.append(receipt);
    const conflicting = makeReceipt("conflict", {
      providerIdentity: canonicalIdentity({ provider: "different" }, DESIGN_AGENT_PROVIDER_SCHEMA)
    });
    await expect(store.append(conflicting)).rejects.toMatchObject({
      failureCode: "AGENT_REPLAY_RECEIPT_CONFLICT"
    });

    const recordPath = path.join(
      root,
      DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME,
      `${receipt.receiptId}.json`
    );
    const parsed = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, any>;
    parsed.providerIdentity.digest = "0".repeat(64);
    await writeFile(recordPath, `${canonicalJson(parsed)}\n`, "utf8");
    await expect(createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(root))).rejects.toMatchObject({
      failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID"
    });
  });

  it("authenticates the chain/head with an external key and detects tail deletion", async () => {
    const keyRoot = await temporaryRoot();
    const first = makeReceipt("keyed-first");
    const second = makeReceipt("keyed-second");
    const store = await createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(keyRoot));
    await store.append(first);
    await store.append(second);

    await expect(createDurableDesignAgentReplayReceiptStore({
      ...receiptStoreOptions(keyRoot),
      integrityKey: Buffer.alloc(32, 0x44)
    })).rejects.toMatchObject({
      failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_AUTHENTICATION_INVALID"
    });

    const headPath = path.join(keyRoot, DESIGN_AGENT_DURABLE_RECEIPT_HEAD_NAME);
    const head = JSON.parse(await readFile(headPath, "utf8")) as Record<string, any>;
    const authentication = head.authentication;
    const { identity: _oldIdentity, authentication: _oldAuthentication, ...headPayload } = head;
    headPayload.totalRecordBytes += 1;
    const forgedIdentity = canonicalIdentity(headPayload, DESIGN_AGENT_DURABLE_RECEIPT_HEAD_SCHEMA);
    await writeFile(headPath, `${canonicalJson({
      ...headPayload,
      identity: forgedIdentity,
      authentication
    })}\n`, "utf8");
    await expect(createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(keyRoot))).rejects.toMatchObject({
      failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_AUTHENTICATION_INVALID"
    });

    const deletionRoot = await temporaryRoot();
    const deletionStore = await createDurableDesignAgentReplayReceiptStore(
      receiptStoreOptions(deletionRoot)
    );
    await deletionStore.append(first);
    await deletionStore.append(second);
    await rm(path.join(
      deletionRoot,
      DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME,
      `${second.receiptId}.json`
    ));
    await expect(createDurableDesignAgentReplayReceiptStore(
      receiptStoreOptions(deletionRoot)
    )).rejects.toMatchObject({
      failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_TRUNCATED"
    });
  });

  it("refuses to append or resolve over a corrupt interior authenticated record", async () => {
    const root = await temporaryRoot();
    const first = makeReceipt("interior-first");
    const second = makeReceipt("interior-second");
    const third = makeReceipt("interior-third");
    const store = await createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(root));
    await store.append(first);
    await store.append(second);
    const firstPath = path.join(
      root,
      DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME,
      `${first.receiptId}.json`
    );
    const tampered = JSON.parse(await readFile(firstPath, "utf8")) as Record<string, any>;
    tampered.authentication.mac = "0".repeat(64);
    await writeFile(firstPath, `${canonicalJson(tampered)}\n`, "utf8");

    await expect(store.append(third)).rejects.toMatchObject({
      failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_AUTHENTICATION_INVALID"
    });
    await expect(store.resolve(second.receiptId)).rejects.toMatchObject({
      failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_AUTHENTICATION_INVALID"
    });
  });

  it("detects truncated and physically reordered records during restart integrity scans", async () => {
    const truncatedRoot = await temporaryRoot();
    const first = makeReceipt("truncated-record");
    const truncatedStore = await createDurableDesignAgentReplayReceiptStore(
      receiptStoreOptions(truncatedRoot)
    );
    await truncatedStore.append(first);
    const truncatedPath = path.join(
      truncatedRoot,
      DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME,
      `${first.receiptId}.json`
    );
    const originalBytes = await readFile(truncatedPath);
    await truncate(truncatedPath, Math.floor(originalBytes.length / 2));
    await expect(createDurableDesignAgentReplayReceiptStore(
      receiptStoreOptions(truncatedRoot)
    )).rejects.toMatchObject({
      failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID"
    });

    const reorderedRoot = await temporaryRoot();
    const second = makeReceipt("reordered-second");
    const reorderedStore = await createDurableDesignAgentReplayReceiptStore(
      receiptStoreOptions(reorderedRoot)
    );
    await reorderedStore.append(first);
    await reorderedStore.append(second);
    const firstPath = path.join(
      reorderedRoot,
      DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME,
      `${first.receiptId}.json`
    );
    const secondPath = path.join(
      reorderedRoot,
      DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME,
      `${second.receiptId}.json`
    );
    const [firstBytes, secondBytes] = await Promise.all([
      readFile(firstPath),
      readFile(secondPath)
    ]);
    await Promise.all([
      writeFile(firstPath, secondBytes),
      writeFile(secondPath, firstBytes)
    ]);
    await expect(createDurableDesignAgentReplayReceiptStore(
      receiptStoreOptions(reorderedRoot)
    )).rejects.toMatchObject({
      failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID"
    });
  });

  it("rejects relative/symlink roots and bounded-record violations", async (context) => {
    await expect(createDurableDesignAgentReplayReceiptStore(
      receiptStoreOptions("relative/receipts")
    )).rejects.toMatchObject({ failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_STORE_INVALID" });

    const boundedRoot = await temporaryRoot();
    await createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(boundedRoot));
    const receipt = makeReceipt("oversized");
    const oversizedPath = path.join(
      boundedRoot,
      DESIGN_AGENT_DURABLE_RECEIPT_DIRECTORY_NAME,
      `${receipt.receiptId}.json`
    );
    await writeFile(oversizedPath, "x", "utf8");
    await truncate(oversizedPath, DESIGN_AGENT_DURABLE_RECEIPT_MAX_RECORD_BYTES + 1);
    await expect(createDurableDesignAgentReplayReceiptStore(
      receiptStoreOptions(boundedRoot)
    )).rejects.toMatchObject({ failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_RECORD_INVALID" });

    const aliasParent = await temporaryRoot();
    const actual = await temporaryRoot();
    const alias = path.join(aliasParent, "root-alias");
    try {
      await symlink(actual, alias, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(createDurableDesignAgentReplayReceiptStore(receiptStoreOptions(alias))).rejects.toMatchObject({
      failureCode: "AGENT_DURABLE_REPLAY_RECEIPT_STORE_INVALID"
    });
  });
});

describe("approved design-agent provider adapter registry", () => {
  const roots: string[] = [];

  const temporaryRoot = async (): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evleda-agent-adapter-"));
    roots.push(root);
    return root;
  };

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }));
  });

  const fixture = async (): Promise<{
    readonly executablePath: string;
    readonly executableIdentity: ReturnType<typeof contentIdentity>;
    readonly generate: ReturnType<typeof vi.fn>;
    readonly registration: DesignAgentProviderAdapterRegistration;
    readonly selection: DesignAgentProviderAdapterSelection;
  }> => {
    const root = await temporaryRoot();
    const executablePath = path.join(root, "fixture-provider-adapter.mjs");
    const executableBytes = Buffer.from(PROVIDER_ADAPTER_BYTES);
    await writeFile(executablePath, executableBytes, { flag: "wx" });
    const executableIdentity = contentIdentity(executableBytes);
    const generate = vi.fn(async () => ({ fixture: true }));
    const port: DesignAgentPort = Object.freeze({ provider: PROVIDER, generate });
    return {
      executablePath,
      executableIdentity,
      generate,
      registration: {
        adapterId: "fixture-adapter",
        provider: PROVIDER_SOURCE,
        approvedModels: [MODEL_SOURCE],
        executablePath,
        expectedExecutableIdentity: executableIdentity,
        port
      },
      selection: {
        adapterId: "fixture-adapter",
        provider: PROVIDER,
        executableIdentity
      }
    };
  };

  const requestForModel = (model = MODEL): DesignAgentProviderRequest => ({
    schemaVersion: DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
    requestIdentity: canonicalIdentity({ request: model.identity }, DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA),
    provider: PROVIDER,
    promptPack: { model } as DesignAgentProviderRequest["promptPack"]
  });

  it("selects only the pre-registered descriptor/executable triple and enforces exact model version", async () => {
    const { registration, selection, generate } = await fixture();
    const registry = await createApprovedDesignAgentProviderAdapterRegistry([registration]);
    const port = await registry.select(selection);
    await expect(port.generate(requestForModel())).resolves.toStrictEqual({ fixture: true });
    expect(generate).toHaveBeenCalledTimes(1);

    const changedVersion = bindDesignAgentModel({ ...MODEL_SOURCE, version: "different-version" });
    await expect(port.generate(requestForModel(changedVersion))).rejects.toMatchObject({
      failureCode: "AGENT_PROVIDER_ADAPTER_MODEL_NOT_APPROVED",
      code: "POLICY_DENIED"
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(port)).toBe(true);
    expect(registry).not.toHaveProperty("authority");
  });

  it("has no default live provider and blocks absent or mismatched trusted selections", async () => {
    const empty = await createApprovedDesignAgentProviderAdapterRegistry([]);
    await expect(empty.select({
      adapterId: "absent-adapter",
      provider: PROVIDER,
      executableIdentity: contentIdentity("absent")
    })).rejects.toMatchObject({
      failureCode: "AGENT_PROVIDER_ADAPTER_UNAVAILABLE",
      code: "CAPABILITY_REQUIRED"
    });

    const { registration, selection } = await fixture();
    const registry = await createApprovedDesignAgentProviderAdapterRegistry([registration]);
    await expect(registry.select({
      ...selection,
      executableIdentity: contentIdentity("different executable")
    })).rejects.toMatchObject({ failureCode: "AGENT_PROVIDER_ADAPTER_SELECTION_MISMATCH" });

    const selfLabeledProviderSource = {
      providerId: PROVIDER.providerId,
      implementationVersion: "self-labeled-build"
    };
    await expect(createApprovedDesignAgentProviderAdapterRegistry([{
      ...registration,
      provider: selfLabeledProviderSource,
      port: Object.freeze({
        provider: bindDesignAgentProvider(selfLabeledProviderSource),
        generate: async () => ({ fixture: true })
      })
    }])).rejects.toMatchObject({
      failureCode: "AGENT_PROVIDER_ADAPTER_PROVENANCE_MISMATCH"
    });
  });

  it("re-authenticates executable bytes on every selection", async () => {
    const { executablePath, registration, selection, generate } = await fixture();
    const registry = await createApprovedDesignAgentProviderAdapterRegistry([registration]);
    const port = await registry.select(selection);
    await writeFile(executablePath, "export const adapterBuild = 'tampered';\n", "utf8");
    await expect(registry.select(selection)).rejects.toMatchObject({
      failureCode: "AGENT_PROVIDER_ADAPTER_EXECUTABLE_MISMATCH"
    });
    await expect(port.generate(requestForModel())).rejects.toMatchObject({
      failureCode: "AGENT_PROVIDER_ADAPTER_EXECUTABLE_MISMATCH"
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects relative/symlink executable paths and accessor-backed ports without invoking accessors", async (context) => {
    const { registration, executablePath } = await fixture();
    await expect(createApprovedDesignAgentProviderAdapterRegistry([{
      ...registration,
      executablePath: "relative/adapter.mjs"
    }])).rejects.toMatchObject({ failureCode: "AGENT_PROVIDER_ADAPTER_REGISTRY_INVALID" });

    let getterReads = 0;
    const accessorPort = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorPort, "provider", { enumerable: true, value: PROVIDER });
    Object.defineProperty(accessorPort, "generate", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return async () => undefined;
      }
    });
    await expect(createApprovedDesignAgentProviderAdapterRegistry([{
      ...registration,
      port: accessorPort as unknown as DesignAgentPort
    }])).rejects.toMatchObject({ failureCode: "AGENT_PROVIDER_ADAPTER_REGISTRY_INVALID" });
    expect(getterReads).toBe(0);

    const aliasParent = await temporaryRoot();
    const aliasDirectory = path.join(aliasParent, "adapter-root-alias");
    try {
      await symlink(path.dirname(executablePath), aliasDirectory, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(createApprovedDesignAgentProviderAdapterRegistry([{
      ...registration,
      executablePath: path.join(aliasDirectory, path.basename(executablePath))
    }])).rejects.toMatchObject({ failureCode: "AGENT_PROVIDER_ADAPTER_EXECUTABLE_INVALID" });
  });

  it("invokes a registered method with a detached frozen receiver instead of its mutable port", async () => {
    const { registration, selection } = await fixture();
    const originalPort = {
      provider: PROVIDER,
      generate: async function (this: { readonly provider: typeof PROVIDER }) {
        return this.provider;
      }
    };
    const registry = await createApprovedDesignAgentProviderAdapterRegistry([{
      ...registration,
      port: originalPort
    }]);
    (originalPort as { provider: typeof PROVIDER }).provider = bindDesignAgentProvider({
      providerId: "mutated-provider",
      implementationVersion: "mutated-version"
    }) as typeof PROVIDER;
    const port = await registry.select(selection);
    await expect(port.generate(requestForModel())).resolves.toStrictEqual(PROVIDER);
  });

  it("composes coordinator-compatible production prerequisites only when exact model policies match", async () => {
    const { registration, selection } = await fixture();
    const trustRoot = await temporaryRoot();
    const receiptRoot = await temporaryRoot();
    const trustStore = await writeManifestFixture(trustRoot);
    const host = await createDesignAgentProductionHost({
      trustStore,
      replayReceiptStore: receiptStoreOptions(receiptRoot),
      providerRegistrations: [registration],
      providerSelection: selection
    });
    expect(() => new DesignAgentCoordinator(
      host.providerPort,
      host.coordinatorPrerequisites
    )).not.toThrow();
    expect(host.coordinatorPrerequisites.deploymentMode).toBe("production");
    expect(host.modelPolicyIdentity.schemaVersion).toBe(
      "evleda.design-agent-production-model-policy.v1"
    );

    const mismatchedModelSource = { ...MODEL_SOURCE, version: "fixture-model-1-v2" };
    const mismatchedProviderSource = {
      providerId: PROVIDER.providerId,
      implementationVersion: designAgentProviderAdapterImplementationVersion(
        "fixture-adapter",
        registration.expectedExecutableIdentity,
        [mismatchedModelSource]
      )
    };
    const mismatchedProvider = bindDesignAgentProvider(mismatchedProviderSource);
    const mismatchReceiptRoot = await temporaryRoot();
    await expect(createDesignAgentProductionHost({
      trustStore,
      replayReceiptStore: receiptStoreOptions(mismatchReceiptRoot),
      providerRegistrations: [{
        ...registration,
        provider: mismatchedProviderSource,
        approvedModels: [mismatchedModelSource],
        port: Object.freeze({
          provider: mismatchedProvider,
          generate: async () => ({ fixture: true })
        })
      }],
      providerSelection: {
        ...selection,
        provider: mismatchedProvider
      }
    })).rejects.toMatchObject({
      failureCode: "AGENT_PRODUCTION_MODEL_POLICY_MISMATCH",
      code: "POLICY_DENIED"
    });
  });
});

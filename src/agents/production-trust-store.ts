import { TextDecoder } from "node:util";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  PCB_ENGINEERING_PRACTICE_SCHEMA,
  validateAndSnapshotPcbEngineeringPracticeCatalog,
  type PcbEngineeringPracticeCatalog
} from "../knowledge/pcb-engineering-practices.js";
import {
  DESIGN_AGENT_CATALOG_LOGICAL_NAME,
  DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
  DESIGN_AGENT_LIMITS,
  DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
  DESIGN_AGENT_PROVIDER_SCHEMA,
  DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
  type AgentTrustStorePort,
  type BoundDesignAgentModel,
  type BoundDesignAgentProvider,
  type DesignAgentTrustManifest
} from "./contracts.js";
import {
  bindDesignAgentProvider,
  bindDesignAgentModel,
  bindDesignAgentTrustManifest
} from "./coordinator.js";
import {
  arrayDataValues,
  boundedIdentifier,
  copyBoundedOrdinaryUint8Array,
  contentIdentitiesEqual,
  deepFreezeProductionValue,
  plainDataProperties,
  productionAgentReject,
  readBoundedOrdinaryFile,
  snapshotAbsolutePath,
  snapshotContentIdentity
} from "./production-boundary.js";
import {
  buildDesignAgentProductionModelPolicy,
  type DesignAgentProductionModelPolicy,
  type DesignAgentProductionModelPolicyEntry
} from "./production-model-policy.js";

export const DESIGN_AGENT_TRUST_MANIFEST_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const DESIGN_AGENT_TRUST_MANIFEST_MAX_BINDINGS_PER_KIND = 64;

export interface TrustedInstructionBindingSource {
  readonly anchor: string;
  /** Exact UTF-8 bytes. A string is encoded as UTF-8 without newline normalization. */
  readonly bytes: string | Uint8Array;
}

export interface TrustedPracticeCatalogBindingSource {
  readonly anchor: string;
  readonly catalog: PcbEngineeringPracticeCatalog;
}

export interface TrustedProviderBindingSource {
  readonly anchor: string;
  /** Unbound source; the store independently derives its canonical descriptor identity. */
  readonly provider: Pick<BoundDesignAgentProvider, "providerId" | "implementationVersion">;
}

export interface TrustedModelFamilyBindingSource {
  readonly anchor: string;
  readonly providerAnchor: string;
  readonly family: string;
  /**
   * Exact current descriptors. Manifest v1 stores only their model-ID projection; the approved
   * adapter registry separately enforces each full versioned identity at invocation time.
   */
  readonly models: readonly Pick<BoundDesignAgentModel, "provider" | "model" | "version">[];
}

export interface DesignAgentTrustManifestExpectedBindings {
  readonly manifestId: string;
  readonly instructions: readonly TrustedInstructionBindingSource[];
  readonly practiceCatalogs: readonly TrustedPracticeCatalogBindingSource[];
  readonly providers: readonly TrustedProviderBindingSource[];
  readonly modelFamilies: readonly TrustedModelFamilyBindingSource[];
  readonly outputContractAnchors: readonly string[];
}

export interface FileBackedDesignAgentTrustStoreOptions {
  /** Absolute canonical path provisioned by the host, never by a run request. */
  readonly manifestPath: string;
  /** Independently provisioned identity of the exact canonical manifest file bytes. */
  readonly expectedContentIdentity: ContentIdentity;
  /** Independently reconstructed current bindings, not identities copied from the file. */
  readonly expectedBindings: DesignAgentTrustManifestExpectedBindings;
}

export type AuthenticatedFileBackedDesignAgentTrustStore = AgentTrustStorePort & {
  readonly authority: "authenticated_production";
};

interface SnapshotExpectedBindings {
  readonly manifestId: string;
  readonly instructions: DesignAgentTrustManifest["instructions"];
  readonly practiceCatalogs: DesignAgentTrustManifest["practiceCatalogs"];
  readonly providers: DesignAgentTrustManifest["providers"];
  readonly modelFamilies: DesignAgentTrustManifest["modelFamilies"];
  readonly outputContracts: DesignAgentTrustManifest["outputContracts"];
  readonly modelPolicy: DesignAgentProductionModelPolicy;
}

interface SnapshotTrustStoreOptions {
  readonly manifestPath: string;
  readonly expectedContentIdentity: ContentIdentity;
  readonly expectedBindings: SnapshotExpectedBindings;
}

const FAILURE = "AGENT_PRODUCTION_TRUST_STORE_INVALID";
const MODEL_POLICIES = new WeakMap<object, DesignAgentProductionModelPolicy>();

const bindProviderSource = (value: unknown, label: string): BoundDesignAgentProvider => {
  const descriptors = plainDataProperties(
    value,
    ["providerId", "implementationVersion"],
    FAILURE,
    label
  );
  return bindDesignAgentProvider({
    providerId: descriptors.providerId!.value,
    implementationVersion: descriptors.implementationVersion!.value
  });
};

const bindModelSource = (value: unknown, label: string): BoundDesignAgentModel => {
  const descriptors = plainDataProperties(
    value,
    ["provider", "model", "version"],
    FAILURE,
    label
  );
  return bindDesignAgentModel({
    provider: descriptors.provider!.value,
    model: descriptors.model!.value,
    version: descriptors.version!.value
  });
};

interface SnapshotProviderBindings {
  readonly manifestBindings: DesignAgentTrustManifest["providers"];
  readonly byAnchor: ReadonlyMap<string, BoundDesignAgentProvider>;
}

interface SnapshotModelFamilyBindings {
  readonly manifestBindings: DesignAgentTrustManifest["modelFamilies"];
  readonly policyEntries: readonly DesignAgentProductionModelPolicyEntry[];
}

const uniqueAnchor = (anchor: string, seen: Set<string>, label: string): void => {
  if (seen.has(anchor)) {
    productionAgentReject("INVALID_ARGUMENT", FAILURE, `${label} contains a duplicate anchor`);
  }
  seen.add(anchor);
};

const snapshotInstructionBindings = (value: unknown): DesignAgentTrustManifest["instructions"] => {
  const values = arrayDataValues(
    value,
    DESIGN_AGENT_TRUST_MANIFEST_MAX_BINDINGS_PER_KIND,
    FAILURE,
    "expectedBindings.instructions"
  );
  const anchors = new Set<string>();
  return deepFreezeProductionValue(values.map((entry, index) => {
    const descriptors = plainDataProperties(
      entry,
      ["anchor", "bytes"],
      FAILURE,
      `expectedBindings.instructions[${index}]`
    );
    const anchor = boundedIdentifier(
      descriptors.anchor!.value,
      FAILURE,
      `expectedBindings.instructions[${index}].anchor`
    );
    uniqueAnchor(anchor, anchors, "expectedBindings.instructions");
    const source = descriptors.bytes!.value;
    let bytes: Buffer;
    if (typeof source === "string") {
      const sourceBytes = Buffer.byteLength(source, "utf8");
      if (sourceBytes < 1 || sourceBytes > DESIGN_AGENT_LIMITS.instructionBytes) {
        productionAgentReject(
          "INVALID_ARGUMENT",
          FAILURE,
          "An expected instruction document exceeds the coordinator byte limit"
        );
      }
      bytes = Buffer.from(source, "utf8");
    } else {
      bytes = copyBoundedOrdinaryUint8Array(
        source,
        1,
        DESIGN_AGENT_LIMITS.instructionBytes,
        FAILURE,
        `expectedBindings.instructions[${index}].bytes`
      );
    }
    if (bytes.length > DESIGN_AGENT_LIMITS.instructionBytes) {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        "An expected instruction document exceeds the coordinator byte limit"
      );
    }
    return {
      anchor,
      logicalName: DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
      identity: Object.freeze(contentIdentity(bytes))
    };
  }));
};

const snapshotCatalogBindings = (
  value: unknown
): DesignAgentTrustManifest["practiceCatalogs"] => {
  const values = arrayDataValues(
    value,
    DESIGN_AGENT_TRUST_MANIFEST_MAX_BINDINGS_PER_KIND,
    FAILURE,
    "expectedBindings.practiceCatalogs"
  );
  const anchors = new Set<string>();
  return deepFreezeProductionValue(values.map((entry, index) => {
    const descriptors = plainDataProperties(
      entry,
      ["anchor", "catalog"],
      FAILURE,
      `expectedBindings.practiceCatalogs[${index}]`
    );
    const anchor = boundedIdentifier(
      descriptors.anchor!.value,
      FAILURE,
      `expectedBindings.practiceCatalogs[${index}].anchor`
    );
    uniqueAnchor(anchor, anchors, "expectedBindings.practiceCatalogs");
    let catalog: PcbEngineeringPracticeCatalog;
    try {
      catalog = validateAndSnapshotPcbEngineeringPracticeCatalog(descriptors.catalog!.value);
    } catch {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        "An expected practice catalog is not the closed current engineering catalog"
      );
    }
    if (catalog.schemaVersion !== PCB_ENGINEERING_PRACTICE_SCHEMA) {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        "An expected practice catalog uses an unsupported schema"
      );
    }
    return {
      anchor,
      logicalName: DESIGN_AGENT_CATALOG_LOGICAL_NAME,
      identity: catalog.identity
    };
  }));
};

const snapshotProviderBindings = (value: unknown): SnapshotProviderBindings => {
  const values = arrayDataValues(
    value,
    DESIGN_AGENT_TRUST_MANIFEST_MAX_BINDINGS_PER_KIND,
    FAILURE,
    "expectedBindings.providers"
  );
  const anchors = new Set<string>();
  const byAnchor = new Map<string, BoundDesignAgentProvider>();
  const manifestBindings = values.map((entry, index) => {
    const descriptors = plainDataProperties(
      entry,
      ["anchor", "provider"],
      FAILURE,
      `expectedBindings.providers[${index}]`
    );
    const anchor = boundedIdentifier(
      descriptors.anchor!.value,
      FAILURE,
      `expectedBindings.providers[${index}].anchor`
    );
    uniqueAnchor(anchor, anchors, "expectedBindings.providers");
    let provider: BoundDesignAgentProvider;
    try {
      provider = bindProviderSource(
        descriptors.provider!.value,
        `expectedBindings.providers[${index}].provider`
      );
    } catch {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        "An expected provider descriptor is invalid"
      );
    }
    if (provider.identity.schemaVersion !== DESIGN_AGENT_PROVIDER_SCHEMA) {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        "An expected provider descriptor uses an unsupported schema"
      );
    }
    byAnchor.set(anchor, provider);
    return { anchor, providerId: provider.providerId, identity: provider.identity };
  });
  return {
    manifestBindings: deepFreezeProductionValue(manifestBindings),
    byAnchor
  };
};

const snapshotModelFamilyBindings = (
  value: unknown,
  providersByAnchor: ReadonlyMap<string, BoundDesignAgentProvider>
): SnapshotModelFamilyBindings => {
  const values = arrayDataValues(
    value,
    DESIGN_AGENT_TRUST_MANIFEST_MAX_BINDINGS_PER_KIND,
    FAILURE,
    "expectedBindings.modelFamilies"
  );
  const anchors = new Set<string>();
  const modelsByProviderAnchor = new Map<string, BoundDesignAgentModel[]>();
  for (const providerAnchor of providersByAnchor.keys()) {
    modelsByProviderAnchor.set(providerAnchor, []);
  }
  const manifestBindings = values.map((entry, index) => {
    const descriptors = plainDataProperties(
      entry,
      ["anchor", "providerAnchor", "family", "models"],
      FAILURE,
      `expectedBindings.modelFamilies[${index}]`
    );
    const anchor = boundedIdentifier(
      descriptors.anchor!.value,
      FAILURE,
      `expectedBindings.modelFamilies[${index}].anchor`
    );
    uniqueAnchor(anchor, anchors, "expectedBindings.modelFamilies");
    const providerAnchor = boundedIdentifier(
      descriptors.providerAnchor!.value,
      FAILURE,
      `expectedBindings.modelFamilies[${index}].providerAnchor`
    );
    const expectedProvider = providersByAnchor.get(providerAnchor);
    if (expectedProvider === undefined) {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        "An expected model family references an unknown provider anchor"
      );
    }
    const modelValues = arrayDataValues(
      descriptors.models!.value,
      64,
      FAILURE,
      `expectedBindings.modelFamilies[${index}].models`
    );
    const seenModels = new Set<string>();
    const modelIds = modelValues.map((modelValue, modelIndex) => {
      let model: BoundDesignAgentModel;
      try {
        model = bindModelSource(
          modelValue,
          `expectedBindings.modelFamilies[${index}].models[${modelIndex}]`
        );
      } catch {
        productionAgentReject(
          "INVALID_ARGUMENT",
          FAILURE,
          `expectedBindings.modelFamilies[${index}].models[${modelIndex}] is invalid`
        );
      }
      if (model.provider !== expectedProvider.providerId) {
        productionAgentReject(
          "INVALID_ARGUMENT",
          FAILURE,
          "An expected model descriptor references a provider different from its anchor"
        );
      }
      const modelId = model.model;
      if (seenModels.has(modelId)) {
        productionAgentReject(
          "INVALID_ARGUMENT",
          FAILURE,
          "An expected model family contains duplicate model IDs"
        );
      }
      seenModels.add(modelId);
      const accumulated = modelsByProviderAnchor.get(providerAnchor) ?? [];
      accumulated.push(model);
      modelsByProviderAnchor.set(providerAnchor, accumulated);
      return modelId;
    });
    return {
      anchor,
      providerAnchor,
      family: boundedIdentifier(
        descriptors.family!.value,
        FAILURE,
        `expectedBindings.modelFamilies[${index}].family`
      ),
      modelIds: Object.freeze(modelIds)
    };
  });
  const policyEntries = [...modelsByProviderAnchor].map(([providerAnchor, models]) => ({
    provider: providersByAnchor.get(providerAnchor)!,
    models: Object.freeze(models)
  }));
  return {
    manifestBindings: deepFreezeProductionValue(manifestBindings),
    policyEntries: deepFreezeProductionValue(policyEntries)
  };
};

const snapshotOutputContracts = (
  value: unknown
): DesignAgentTrustManifest["outputContracts"] => {
  const values = arrayDataValues(
    value,
    DESIGN_AGENT_TRUST_MANIFEST_MAX_BINDINGS_PER_KIND,
    FAILURE,
    "expectedBindings.outputContractAnchors"
  );
  const anchors = new Set<string>();
  return deepFreezeProductionValue(values.map((entry, index) => {
    const anchor = boundedIdentifier(
      entry,
      FAILURE,
      `expectedBindings.outputContractAnchors[${index}]`
    );
    uniqueAnchor(anchor, anchors, "expectedBindings.outputContractAnchors");
    return {
      anchor,
      logicalName: DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME,
      bytesIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
      canonicalIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY
    };
  }));
};

const snapshotOptions = (value: unknown): SnapshotTrustStoreOptions => {
  const descriptors = plainDataProperties(
    value,
    ["manifestPath", "expectedContentIdentity", "expectedBindings"],
    FAILURE,
    "trustStoreOptions"
  );
  const manifestPath = snapshotAbsolutePath(
    descriptors.manifestPath!.value,
    FAILURE,
    "trustStoreOptions.manifestPath"
  );
  const expectedContentIdentity = snapshotContentIdentity(
    descriptors.expectedContentIdentity!.value,
    FAILURE,
    "trustStoreOptions.expectedContentIdentity"
  );
  if (expectedContentIdentity.size > DESIGN_AGENT_TRUST_MANIFEST_FILE_MAX_BYTES) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      FAILURE,
      "Configured trust-manifest identity exceeds the file-size limit"
    );
  }
  const bindingDescriptors = plainDataProperties(
    descriptors.expectedBindings!.value,
    [
      "manifestId",
      "instructions",
      "practiceCatalogs",
      "providers",
      "modelFamilies",
      "outputContractAnchors"
    ],
    FAILURE,
    "trustStoreOptions.expectedBindings"
  );
  const providers = snapshotProviderBindings(bindingDescriptors.providers!.value);
  const modelFamilies = snapshotModelFamilyBindings(
    bindingDescriptors.modelFamilies!.value,
    providers.byAnchor
  );
  const expectedBindings: SnapshotExpectedBindings = deepFreezeProductionValue({
    manifestId: boundedIdentifier(
      bindingDescriptors.manifestId!.value,
      FAILURE,
      "expectedBindings.manifestId"
    ),
    instructions: snapshotInstructionBindings(bindingDescriptors.instructions!.value),
    practiceCatalogs: snapshotCatalogBindings(bindingDescriptors.practiceCatalogs!.value),
    providers: providers.manifestBindings,
    modelFamilies: modelFamilies.manifestBindings,
    outputContracts: snapshotOutputContracts(bindingDescriptors.outputContractAnchors!.value),
    modelPolicy: buildDesignAgentProductionModelPolicy(modelFamilies.policyEntries)
  });
  return deepFreezeProductionValue({ manifestPath, expectedContentIdentity, expectedBindings });
};

const assertCanonicalFile = (bytes: Buffer, manifest: DesignAgentTrustManifest): void => {
  const expected = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  if (!bytes.equals(expected)) {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_TRUST_MANIFEST_NOT_CANONICAL",
      "Trust-manifest file must contain exactly one canonical JSON record and one trailing newline"
    );
  }
};

const assertExpectedBindings = (
  manifest: DesignAgentTrustManifest,
  expected: SnapshotExpectedBindings
): void => {
  const comparisons: readonly [string, unknown, unknown][] = [
    ["instruction", manifest.instructions, expected.instructions],
    ["practice catalog", manifest.practiceCatalogs, expected.practiceCatalogs],
    ["provider", manifest.providers, expected.providers],
    ["model family", manifest.modelFamilies, expected.modelFamilies],
    ["output contract", manifest.outputContracts, expected.outputContracts]
  ];
  if (manifest.manifestId !== expected.manifestId) {
    productionAgentReject(
      "POLICY_DENIED",
      "AGENT_TRUST_MANIFEST_BINDING_MISMATCH",
      "Trust-manifest ID differs from the independently configured ID"
    );
  }
  for (const [kind, actual, independentlyExpected] of comparisons) {
    if (canonicalJson(actual) !== canonicalJson(independentlyExpected)) {
      productionAgentReject(
        "POLICY_DENIED",
        "AGENT_TRUST_MANIFEST_BINDING_MISMATCH",
        `Trust-manifest ${kind} anchors differ from the independently reconstructed bindings`
      );
    }
  }
};

/**
 * Loads one authenticated deployment manifest into an immutable memory snapshot. The manifest
 * path, expected file hash, and expected anchor sources are all host-composition inputs; none are
 * accepted by coordinator execution or replay requests.
 */
export const createFileBackedDesignAgentTrustStore = async (
  optionsValue: FileBackedDesignAgentTrustStoreOptions
): Promise<AuthenticatedFileBackedDesignAgentTrustStore> => {
  // Deliberately complete the configuration snapshot before the first await.
  const options = snapshotOptions(optionsValue);
  let file;
  try {
    file = await readBoundedOrdinaryFile(
      options.manifestPath,
      DESIGN_AGENT_TRUST_MANIFEST_FILE_MAX_BYTES,
      FAILURE,
      "Design-agent trust manifest"
    );
  } catch (error) {
    if (error instanceof Error && "failureCode" in error) throw error;
    productionAgentReject(
      "POLICY_DENIED",
      "AGENT_TRUST_MANIFEST_READ_FAILED",
      "Configured trust-manifest file could not be authenticated"
    );
  }
  if (!contentIdentitiesEqual(file.identity, options.expectedContentIdentity)) {
    productionAgentReject(
      "DIGEST_MISMATCH",
      "AGENT_TRUST_MANIFEST_CONTENT_MISMATCH",
      "Trust-manifest file bytes differ from the independently configured content identity",
      {
        expected: options.expectedContentIdentity,
        actual: file.identity
      }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes));
  } catch {
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_TRUST_MANIFEST_INVALID_JSON",
      "Trust-manifest file is not strict UTF-8 JSON"
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== DESIGN_AGENT_TRUST_MANIFEST_SCHEMA
  ) {
    productionAgentReject(
      "POLICY_DENIED",
      "AGENT_TRUST_MANIFEST_SCHEMA_UNSUPPORTED",
      "Trust-manifest file uses an unsupported schema"
    );
  }
  let manifest: DesignAgentTrustManifest;
  try {
    const recordDescriptors = plainDataProperties(
      parsed,
      [
        "schemaVersion",
        "manifestId",
        "instructions",
        "practiceCatalogs",
        "providers",
        "modelFamilies",
        "outputContracts",
        "identity"
      ],
      "AGENT_TRUST_MANIFEST_INVALID",
      "trustManifest"
    );
    manifest = bindDesignAgentTrustManifest({
      manifestId: recordDescriptors.manifestId!.value,
      instructions: recordDescriptors.instructions!.value,
      practiceCatalogs: recordDescriptors.practiceCatalogs!.value,
      providers: recordDescriptors.providers!.value,
      modelFamilies: recordDescriptors.modelFamilies!.value,
      outputContracts: recordDescriptors.outputContracts!.value
    });
    if (canonicalJson(manifest) !== canonicalJson(parsed)) {
      productionAgentReject(
        "DIGEST_MISMATCH",
        "AGENT_TRUST_MANIFEST_IDENTITY_MISMATCH",
        "Trust-manifest embedded identity does not reproduce"
      );
    }
  } catch (error) {
    if (error instanceof Error && "failureCode" in error) throw error;
    productionAgentReject(
      "ARTIFACT_INTEGRITY_ERROR",
      "AGENT_TRUST_MANIFEST_INVALID",
      "Trust-manifest record failed closed validation"
    );
  }
  assertCanonicalFile(file.bytes, manifest);
  assertExpectedBindings(manifest, options.expectedBindings);

  const resolve = (manifestId: string): unknown =>
    manifestId === manifest.manifestId ? manifest : undefined;
  const store = Object.freeze({
    authority: "authenticated_production" as const,
    resolve
  });
  MODEL_POLICIES.set(store, options.expectedBindings.modelPolicy);
  return store;
};

/** Returns exact versioned model policy metadata only for a store created by this factory. */
export const authenticatedTrustStoreModelPolicy = (
  store: AuthenticatedFileBackedDesignAgentTrustStore
): DesignAgentProductionModelPolicy => {
  const policy = MODEL_POLICIES.get(store);
  if (policy === undefined) {
    productionAgentReject(
      "POLICY_DENIED",
      "AGENT_PRODUCTION_MODEL_POLICY_UNAVAILABLE",
      "Trust store was not created by the authenticated production factory"
    );
  }
  return policy;
};

export const designAgentTrustManifestFileIdentity = (
  manifest: DesignAgentTrustManifest
): ContentIdentity => contentIdentity(`${canonicalJson(manifest)}\n`);

export const designAgentTrustManifestCanonicalBytes = (
  manifest: DesignAgentTrustManifest
): Buffer => Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");

export const assertCanonicalIdentityMatch = (
  actual: CanonicalIdentity,
  expected: CanonicalIdentity
): void => {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    productionAgentReject(
      "DIGEST_MISMATCH",
      "AGENT_TRUST_MANIFEST_BINDING_MISMATCH",
      "Canonical identities differ"
    );
  }
};

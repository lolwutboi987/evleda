import { types as nodeTypes } from "node:util";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type {
  BoundDesignAgentModel,
  BoundDesignAgentProvider,
  DesignAgentPort,
  DesignAgentProviderRequest
} from "./contracts.js";
import { DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA } from "./contracts.js";
import { bindDesignAgentModel, bindDesignAgentProvider } from "./coordinator.js";
import {
  arrayDataValues,
  boundedIdentifier,
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
  type DesignAgentProductionModelPolicy
} from "./production-model-policy.js";

export const DESIGN_AGENT_PROVIDER_ADAPTER_MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
export const DESIGN_AGENT_PROVIDER_ADAPTER_MAX_AGGREGATE_EXECUTABLE_BYTES = 256 * 1024 * 1024;
export const DESIGN_AGENT_PROVIDER_ADAPTER_MAX_REGISTRATIONS = 32;
export const DESIGN_AGENT_PROVIDER_ADAPTER_BINDING_SCHEMA =
  "evleda.design-agent-provider-adapter-binding.v1" as const;

/** Host-composition registration. It must never be constructed from a run request. */
export interface DesignAgentProviderAdapterRegistration {
  readonly adapterId: string;
  /** Unbound descriptor source; its identity is independently reconstructed. */
  readonly provider: Pick<BoundDesignAgentProvider, "providerId" | "implementationVersion">;
  /** Exact versioned model descriptors this adapter is permitted to receive. */
  readonly approvedModels: readonly Pick<
    BoundDesignAgentModel,
    "provider" | "model" | "version"
  >[];
  readonly executablePath: string;
  readonly expectedExecutableIdentity: ContentIdentity;
  /**
   * Preloaded host callable associated with `executablePath` by trusted composition. The registry
   * detaches its receiver and re-authenticates artifact bytes on every call; the callable must not
   * consult mutable closure state as authority.
   */
  readonly port: DesignAgentPort;
}

/** Exact trusted selection configured by production composition, never by invocation data. */
export interface DesignAgentProviderAdapterSelection {
  readonly adapterId: string;
  readonly provider: BoundDesignAgentProvider;
  readonly executableIdentity: ContentIdentity;
}

export interface ApprovedDesignAgentProviderAdapterRegistry {
  /**
   * Returns only a pre-registered port whose ID, descriptor, and executable bytes all match.
   * An empty registry is valid; selecting from it blocks live agentic mode.
   */
  select(selection: DesignAgentProviderAdapterSelection): Promise<DesignAgentPort>;
}

interface SnapshotRegistration {
  readonly adapterId: string;
  readonly provider: BoundDesignAgentProvider;
  readonly executablePath: string;
  readonly expectedExecutableIdentity: ContentIdentity;
  readonly approvedModels: readonly BoundDesignAgentModel[];
  readonly port: DesignAgentPort;
}

const FAILURE = "AGENT_PROVIDER_ADAPTER_REGISTRY_INVALID";
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

const canonicalIdentityMatches = (value: unknown, expected: CanonicalIdentity): boolean => {
  try {
    const descriptors = plainDataProperties(
      value,
      ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"],
      FAILURE,
      "canonicalIdentity"
    );
    return descriptors.algorithm!.value === expected.algorithm &&
      descriptors.digest!.value === expected.digest &&
      descriptors.schemaVersion!.value === expected.schemaVersion &&
      descriptors.canonicalizationVersion!.value === expected.canonicalizationVersion;
  } catch {
    return false;
  }
};

const boundAdapterImplementationVersion = (
  adapterId: string,
  executableIdentity: ContentIdentity,
  approvedModels: readonly BoundDesignAgentModel[]
): string => {
  const payload = {
    adapterId,
    executableIdentity,
    approvedModelIdentities: approvedModels
      .map((model) => model.identity)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), "en-US"))
  };
  return `adapter-${canonicalIdentity(payload, DESIGN_AGENT_PROVIDER_ADAPTER_BINDING_SCHEMA).digest}`;
};

/**
 * Derives the only accepted provider implementation version from the adapter ID, exact artifact
 * bytes, and exact approved model identities. The resulting provider identity is therefore
 * carried through coordinator prompt, replay, result, and receipt provenance.
 */
export const designAgentProviderAdapterImplementationVersion = (
  adapterIdValue: string,
  executableIdentityValue: ContentIdentity,
  approvedModelValues: readonly Pick<BoundDesignAgentModel, "provider" | "model" | "version">[]
): string => {
  const adapterId = boundedIdentifier(
    adapterIdValue,
    FAILURE,
    "providerAdapter.adapterId"
  );
  const executableIdentity = snapshotContentIdentity(
    executableIdentityValue,
    FAILURE,
    "providerAdapter.executableIdentity"
  );
  const modelValues = arrayDataValues(
    approvedModelValues,
    64,
    FAILURE,
    "providerAdapter.approvedModels"
  );
  const approvedModels = modelValues.map((value, index) => {
    try {
      return bindModelSource(value, `providerAdapter.approvedModels[${index}]`);
    } catch {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        `providerAdapter.approvedModels[${index}] is invalid`
      );
    }
  });
  return boundAdapterImplementationVersion(adapterId, executableIdentity, approvedModels);
};

const validateBoundProvider = (value: unknown, label: string): BoundDesignAgentProvider => {
  const descriptors = plainDataProperties(
    value,
    ["providerId", "implementationVersion", "identity"],
    FAILURE,
    label
  );
  const rebound = bindDesignAgentProvider({
    providerId: descriptors.providerId!.value,
    implementationVersion: descriptors.implementationVersion!.value
  });
  if (!canonicalIdentityMatches(descriptors.identity!.value, rebound.identity)) {
    productionAgentReject(
      "DIGEST_MISMATCH",
      "AGENT_PROVIDER_ADAPTER_DESCRIPTOR_MISMATCH",
      `${label} identity does not reproduce`
    );
  }
  return rebound;
};

const validateBoundModel = (value: unknown, label: string): BoundDesignAgentModel => {
  const descriptors = plainDataProperties(
    value,
    ["provider", "model", "version", "identity"],
    FAILURE,
    label
  );
  const rebound = bindDesignAgentModel({
    provider: descriptors.provider!.value,
    model: descriptors.model!.value,
    version: descriptors.version!.value
  });
  if (!canonicalIdentityMatches(descriptors.identity!.value, rebound.identity)) {
    productionAgentReject(
      "DIGEST_MISMATCH",
      "AGENT_PROVIDER_ADAPTER_MODEL_MISMATCH",
      `${label} identity does not reproduce`
    );
  }
  return rebound;
};

const inspectPort = (value: unknown): DesignAgentPort => {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      FAILURE,
      "Provider adapter port must be a non-proxy plain object"
    );
  }
  const descriptors = plainDataProperties(
    value,
    ["provider", "generate"],
    FAILURE,
    "providerAdapter.port"
  );
  let provider: BoundDesignAgentProvider;
  try {
    provider = validateBoundProvider(descriptors.provider!.value, "providerAdapter.port.provider");
  } catch {
    productionAgentReject(
      "INVALID_ARGUMENT",
      FAILURE,
      "Provider adapter port has an invalid provider descriptor"
    );
  }
  const generate = descriptors.generate!.value;
  if (typeof generate !== "function" || nodeTypes.isProxy(generate)) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      FAILURE,
      "Provider adapter generate must be a non-proxy function"
    );
  }
  const detachedReceiver = Object.freeze({ provider });
  return Object.freeze({
    provider,
    generate: async (request: DesignAgentProviderRequest, signal?: AbortSignal) =>
      (await Reflect.apply(generate, detachedReceiver, [request, signal])) as unknown
  });
};

const snapshotRegistrations = (value: unknown): readonly SnapshotRegistration[] => {
  const values = arrayDataValues(
    value,
    DESIGN_AGENT_PROVIDER_ADAPTER_MAX_REGISTRATIONS,
    FAILURE,
    "providerAdapterRegistrations",
    true
  );
  const ids = new Set<string>();
  const snapshots = values.map((entry, index) => {
    const descriptors = plainDataProperties(
      entry,
      [
        "adapterId",
        "provider",
        "approvedModels",
        "executablePath",
        "expectedExecutableIdentity",
        "port"
      ],
      FAILURE,
      `providerAdapterRegistrations[${index}]`
    );
    const adapterId = boundedIdentifier(
      descriptors.adapterId!.value,
      FAILURE,
      `providerAdapterRegistrations[${index}].adapterId`
    );
    if (ids.has(adapterId)) {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        "Provider adapter registrations contain a duplicate adapter ID"
      );
    }
    ids.add(adapterId);
    let provider: BoundDesignAgentProvider;
    try {
      provider = bindProviderSource(
        descriptors.provider!.value,
        `providerAdapterRegistrations[${index}].provider`
      );
    } catch {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        "Provider adapter registration has an invalid trusted descriptor"
      );
    }
    const port = inspectPort(descriptors.port!.value);
    if (canonicalJson(port.provider) !== canonicalJson(provider)) {
      productionAgentReject(
        "DIGEST_MISMATCH",
        "AGENT_PROVIDER_ADAPTER_DESCRIPTOR_MISMATCH",
        "Provider adapter port descriptor differs from its independently registered descriptor"
      );
    }
    const approvedModelValues = arrayDataValues(
      descriptors.approvedModels!.value,
      64,
      FAILURE,
      `providerAdapterRegistrations[${index}].approvedModels`
    );
    const modelIdentities = new Set<string>();
    const approvedModels = Object.freeze(approvedModelValues.map((modelValue, modelIndex) => {
      let model: BoundDesignAgentModel;
      try {
        model = bindModelSource(
          modelValue,
          `providerAdapterRegistrations[${index}].approvedModels[${modelIndex}]`
        );
      } catch {
        productionAgentReject(
          "INVALID_ARGUMENT",
          FAILURE,
          `providerAdapterRegistrations[${index}].approvedModels[${modelIndex}] is invalid`
        );
      }
      if (model.provider !== provider.providerId) {
        productionAgentReject(
          "INVALID_ARGUMENT",
          FAILURE,
          "Approved model descriptor provider differs from the adapter provider"
        );
      }
      if (modelIdentities.has(model.identity.digest)) {
        productionAgentReject(
          "INVALID_ARGUMENT",
          FAILURE,
          "Provider adapter registration contains a duplicate approved model identity"
        );
      }
      modelIdentities.add(model.identity.digest);
      return model;
    }));
    const expectedExecutableIdentity = snapshotContentIdentity(
      descriptors.expectedExecutableIdentity!.value,
      FAILURE,
      `providerAdapterRegistrations[${index}].expectedExecutableIdentity`
    );
    if (expectedExecutableIdentity.size > DESIGN_AGENT_PROVIDER_ADAPTER_MAX_EXECUTABLE_BYTES) {
      productionAgentReject(
        "INVALID_ARGUMENT",
        FAILURE,
        "Provider adapter executable identity exceeds the byte limit"
      );
    }
    const requiredImplementationVersion = boundAdapterImplementationVersion(
      adapterId,
      expectedExecutableIdentity,
      approvedModels
    );
    if (provider.implementationVersion !== requiredImplementationVersion) {
      productionAgentReject(
        "DIGEST_MISMATCH",
        "AGENT_PROVIDER_ADAPTER_PROVENANCE_MISMATCH",
        "Provider descriptor implementationVersion does not bind the adapter ID, executable, and exact model policy",
        { requiredImplementationVersion }
      );
    }
    return Object.freeze({
      adapterId,
      provider,
      executablePath: snapshotAbsolutePath(
        descriptors.executablePath!.value,
        FAILURE,
        `providerAdapterRegistrations[${index}].executablePath`
      ),
      expectedExecutableIdentity,
      approvedModels,
      port
    });
  });
  const aggregateExecutableBytes = snapshots.reduce(
    (sum, registration) => sum + registration.expectedExecutableIdentity.size,
    0
  );
  if (aggregateExecutableBytes > DESIGN_AGENT_PROVIDER_ADAPTER_MAX_AGGREGATE_EXECUTABLE_BYTES) {
    productionAgentReject(
      "INVALID_ARGUMENT",
      FAILURE,
      "Provider adapter registrations exceed the aggregate executable-byte limit"
    );
  }
  return Object.freeze(snapshots);
};

const authenticateExecutable = async (registration: SnapshotRegistration): Promise<void> => {
  let executable;
  try {
    executable = await readBoundedOrdinaryFile(
      registration.executablePath,
      DESIGN_AGENT_PROVIDER_ADAPTER_MAX_EXECUTABLE_BYTES,
      "AGENT_PROVIDER_ADAPTER_EXECUTABLE_INVALID",
      "Provider adapter executable"
    );
  } catch (error) {
    if (error instanceof Error && "failureCode" in error) throw error;
    productionAgentReject(
      "CAPABILITY_REQUIRED",
      "AGENT_PROVIDER_ADAPTER_EXECUTABLE_UNAVAILABLE",
      "Configured provider adapter executable is unavailable"
    );
  }
  if (!contentIdentitiesEqual(executable.identity, registration.expectedExecutableIdentity)) {
    productionAgentReject(
      "DIGEST_MISMATCH",
      "AGENT_PROVIDER_ADAPTER_EXECUTABLE_MISMATCH",
      "Provider adapter executable differs from its independently registered identity",
      {
        expected: registration.expectedExecutableIdentity,
        actual: executable.identity
      }
    );
  }
};

export const snapshotDesignAgentProviderAdapterSelection = (
  value: unknown
): DesignAgentProviderAdapterSelection => {
  const descriptors = plainDataProperties(
    value,
    ["adapterId", "provider", "executableIdentity"],
    "AGENT_PROVIDER_ADAPTER_SELECTION_INVALID",
    "providerAdapterSelection"
  );
  let provider: BoundDesignAgentProvider;
  try {
    provider = validateBoundProvider(
      descriptors.provider!.value,
      "providerAdapterSelection.provider"
    );
  } catch {
    productionAgentReject(
      "INVALID_ARGUMENT",
      "AGENT_PROVIDER_ADAPTER_SELECTION_INVALID",
      "Provider adapter selection has an invalid descriptor"
    );
  }
  return deepFreezeProductionValue({
    adapterId: boundedIdentifier(
      descriptors.adapterId!.value,
      "AGENT_PROVIDER_ADAPTER_SELECTION_INVALID",
      "providerAdapterSelection.adapterId"
    ),
    provider,
    executableIdentity: snapshotContentIdentity(
      descriptors.executableIdentity!.value,
      "AGENT_PROVIDER_ADAPTER_SELECTION_INVALID",
      "providerAdapterSelection.executableIdentity"
    )
  });
};

/**
 * Builds a closed registry with no vendor SDK and no default live provider. Creating an empty
 * registry is intentional: deterministic product paths can remain available while live agentic
 * selection fails closed.
 */
export const createApprovedDesignAgentProviderAdapterRegistry = async (
  registrationsValue: readonly DesignAgentProviderAdapterRegistration[]
): Promise<ApprovedDesignAgentProviderAdapterRegistry> => {
  // Snapshot descriptors, paths, identities, and callable references before the first await.
  const registrations = snapshotRegistrations(registrationsValue);
  // Authenticate sequentially so the per-file bound is also the peak read-buffer bound.
  for (const registration of registrations) {
    await authenticateExecutable(registration);
  }

  const select = async (selectionValue: DesignAgentProviderAdapterSelection): Promise<DesignAgentPort> => {
    // Snapshot selection before file authentication yields.
    const selection = snapshotDesignAgentProviderAdapterSelection(selectionValue);
    const sameId = registrations.find((registration) => registration.adapterId === selection.adapterId);
    if (sameId === undefined) {
      productionAgentReject(
        "CAPABILITY_REQUIRED",
        "AGENT_PROVIDER_ADAPTER_UNAVAILABLE",
        "No approved live design-agent provider adapter matches the trusted selection"
      );
    }
    if (
      canonicalJson(sameId.provider) !== canonicalJson(selection.provider) ||
      !contentIdentitiesEqual(
        sameId.expectedExecutableIdentity,
        selection.executableIdentity
      )
    ) {
      productionAgentReject(
        "POLICY_DENIED",
        "AGENT_PROVIDER_ADAPTER_SELECTION_MISMATCH",
        "Trusted provider selection does not match the pre-registered descriptor and executable"
      );
    }
    await authenticateExecutable(sameId);
    const approvedModels = sameId.approvedModels;
    const port = sameId.port;
    return Object.freeze({
      provider: port.provider,
      generate: async (request: DesignAgentProviderRequest, signal?: AbortSignal) => {
        // Selection is not a lease over mutable host files. Re-authenticate immediately before
        // every invocation so a post-selection adapter-artifact change fails closed.
        await authenticateExecutable(sameId);
        const requestDescriptors = plainDataProperties(
          request,
          ["schemaVersion", "requestIdentity", "provider", "promptPack"],
          "AGENT_PROVIDER_ADAPTER_REQUEST_INVALID",
          "providerRequest"
        );
        if (requestDescriptors.schemaVersion!.value !== DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA) {
          productionAgentReject(
            "INVALID_ARGUMENT",
            "AGENT_PROVIDER_ADAPTER_REQUEST_INVALID",
            "Provider request uses an unsupported schema"
          );
        }
        const requestProvider = validateBoundProvider(
          requestDescriptors.provider!.value,
          "providerRequest.provider"
        );
        if (canonicalJson(requestProvider) !== canonicalJson(sameId.provider)) {
          productionAgentReject(
            "POLICY_DENIED",
            "AGENT_PROVIDER_ADAPTER_REQUEST_INVALID",
            "Provider request descriptor differs from the selected approved adapter"
          );
        }
        const promptPack = requestDescriptors.promptPack!.value;
        if (
          promptPack === null ||
          typeof promptPack !== "object" ||
          nodeTypes.isProxy(promptPack) ||
          (Object.getPrototypeOf(promptPack) !== Object.prototype &&
            Object.getPrototypeOf(promptPack) !== null)
        ) {
          productionAgentReject(
            "INVALID_ARGUMENT",
            "AGENT_PROVIDER_ADAPTER_REQUEST_INVALID",
            "Provider request prompt pack must be a non-proxy plain object"
          );
        }
        const modelDescriptor = Object.getOwnPropertyDescriptor(promptPack, "model");
        if (
          modelDescriptor === undefined ||
          !("value" in modelDescriptor) ||
          modelDescriptor.enumerable !== true
        ) {
          productionAgentReject(
            "INVALID_ARGUMENT",
            "AGENT_PROVIDER_ADAPTER_REQUEST_INVALID",
            "Provider request model must be an enumerable data property"
          );
        }
        const model = validateBoundModel(modelDescriptor.value, "providerRequest.promptPack.model");
        if (!approvedModels.some((approved) => canonicalJson(approved) === canonicalJson(model))) {
          productionAgentReject(
            "POLICY_DENIED",
            "AGENT_PROVIDER_ADAPTER_MODEL_NOT_APPROVED",
            "Provider request model descriptor is not an exact pre-approved version"
          );
        }
        return await port.generate(request, signal);
      }
    });
  };

  const registry = Object.freeze({ select });
  MODEL_POLICIES.set(
    registry,
    buildDesignAgentProductionModelPolicy(registrations.map((registration) => ({
      provider: registration.provider,
      models: registration.approvedModels
    })))
  );
  return registry;
};

/** Returns exact versioned model policy metadata only for a registry created by this factory. */
export const approvedProviderRegistryModelPolicy = (
  registry: ApprovedDesignAgentProviderAdapterRegistry
): DesignAgentProductionModelPolicy => {
  const policy = MODEL_POLICIES.get(registry);
  if (policy === undefined) {
    productionAgentReject(
      "POLICY_DENIED",
      "AGENT_PRODUCTION_MODEL_POLICY_UNAVAILABLE",
      "Provider registry was not created by the approved production factory"
    );
  }
  return policy;
};

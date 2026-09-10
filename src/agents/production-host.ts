import { canonicalJson } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type {
  DesignAgentPort,
  DesignAgentProductionCoordinatorPrerequisites
} from "./contracts.js";
import {
  approvedProviderRegistryModelPolicy,
  createApprovedDesignAgentProviderAdapterRegistry,
  snapshotDesignAgentProviderAdapterSelection,
  type DesignAgentProviderAdapterRegistration,
  type DesignAgentProviderAdapterSelection
} from "./provider-adapter-registry.js";
import {
  boundedIdentifier,
  deepFreezeProductionValue,
  plainDataProperties,
  productionAgentReject
} from "./production-boundary.js";
import {
  authenticatedTrustStoreModelPolicy,
  createFileBackedDesignAgentTrustStore,
  type FileBackedDesignAgentTrustStoreOptions
} from "./production-trust-store.js";
import {
  createDurableDesignAgentReplayReceiptStore,
  type DurableDesignAgentReplayReceiptStoreOptions
} from "./replay-receipt-store.js";

export interface DesignAgentProductionHostOptions {
  readonly trustStore: FileBackedDesignAgentTrustStoreOptions;
  readonly replayReceiptStore: DurableDesignAgentReplayReceiptStoreOptions;
  readonly providerRegistrations: readonly DesignAgentProviderAdapterRegistration[];
  readonly providerSelection: DesignAgentProviderAdapterSelection;
}

export interface DesignAgentProductionHost {
  readonly providerPort: DesignAgentPort;
  readonly coordinatorPrerequisites: DesignAgentProductionCoordinatorPrerequisites;
  readonly modelPolicyIdentity: CanonicalIdentity;
}

/**
 * The only all-in-one production constructor. It proves that the authenticated manifest's exact
 * versioned model sources and the approved adapter registry's exact model set are identical before
 * returning a coordinator-compatible port and prerequisites. Deterministic application paths need
 * not call this factory and remain independent when live agentic composition is unavailable.
 */
export const createDesignAgentProductionHost = async (
  optionsValue: DesignAgentProductionHostOptions
): Promise<DesignAgentProductionHost> => {
  const descriptors = plainDataProperties(
    optionsValue,
    ["trustStore", "replayReceiptStore", "providerRegistrations", "providerSelection"],
    "AGENT_PRODUCTION_HOST_INVALID",
    "designAgentProductionHostOptions"
  );
  const trustOptions = descriptors.trustStore!.value as FileBackedDesignAgentTrustStoreOptions;
  const trustDescriptors = plainDataProperties(
    trustOptions,
    ["manifestPath", "expectedContentIdentity", "expectedBindings"],
    "AGENT_PRODUCTION_HOST_INVALID",
    "designAgentProductionHostOptions.trustStore"
  );
  const bindingDescriptors = plainDataProperties(
    trustDescriptors.expectedBindings!.value,
    [
      "manifestId",
      "instructions",
      "practiceCatalogs",
      "providers",
      "modelFamilies",
      "outputContractAnchors"
    ],
    "AGENT_PRODUCTION_HOST_INVALID",
    "designAgentProductionHostOptions.trustStore.expectedBindings"
  );
  const trustManifestId = boundedIdentifier(
    bindingDescriptors.manifestId!.value,
    "AGENT_PRODUCTION_HOST_INVALID",
    "designAgentProductionHostOptions.trustStore.expectedBindings.manifestId"
  );
  const providerSelection = snapshotDesignAgentProviderAdapterSelection(
    descriptors.providerSelection!.value
  );

  // Every child factory snapshots its complete configuration synchronously before its first await.
  const trustStorePromise = createFileBackedDesignAgentTrustStore(trustOptions);
  const receiptStorePromise = createDurableDesignAgentReplayReceiptStore(
    descriptors.replayReceiptStore!.value as DurableDesignAgentReplayReceiptStoreOptions
  );
  const registryPromise = createApprovedDesignAgentProviderAdapterRegistry(
    descriptors.providerRegistrations!.value as readonly DesignAgentProviderAdapterRegistration[]
  );
  const [trustStore, replayReceiptStore, registry] = await Promise.all([
    trustStorePromise,
    receiptStorePromise,
    registryPromise
  ]);

  const trustPolicy = authenticatedTrustStoreModelPolicy(trustStore);
  const registryPolicy = approvedProviderRegistryModelPolicy(registry);
  if (registryPolicy.providers.length === 0) {
    productionAgentReject(
      "CAPABILITY_REQUIRED",
      "AGENT_PROVIDER_ADAPTER_UNAVAILABLE",
      "Production agentic host has no approved provider adapter; deterministic paths remain available"
    );
  }
  if (canonicalJson(trustPolicy) !== canonicalJson(registryPolicy)) {
    productionAgentReject(
      "POLICY_DENIED",
      "AGENT_PRODUCTION_MODEL_POLICY_MISMATCH",
      "Authenticated trust manifest and approved provider registry do not bind the same exact model versions"
    );
  }
  const providerPort = await registry.select(providerSelection);
  const coordinatorPrerequisites: DesignAgentProductionCoordinatorPrerequisites = Object.freeze({
    deploymentMode: "production" as const,
    trustManifestId,
    trustStore,
    replayReceiptStore
  });
  return deepFreezeProductionValue({
    providerPort,
    coordinatorPrerequisites,
    modelPolicyIdentity: trustPolicy.identity
  });
};

import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type { BoundDesignAgentModel, BoundDesignAgentProvider } from "./contracts.js";
import { deepFreezeProductionValue, productionAgentReject } from "./production-boundary.js";

export const DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA =
  "evleda.design-agent-production-model-policy.v1" as const;

export interface DesignAgentProductionModelPolicyEntry {
  readonly provider: BoundDesignAgentProvider;
  readonly models: readonly BoundDesignAgentModel[];
}

export interface DesignAgentProductionModelPolicy {
  readonly schemaVersion: typeof DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA;
  readonly providers: readonly DesignAgentProductionModelPolicyEntry[];
  readonly identity: CanonicalIdentity;
}

export const buildDesignAgentProductionModelPolicy = (
  entries: readonly DesignAgentProductionModelPolicyEntry[]
): DesignAgentProductionModelPolicy => {
  const byProviderId = new Map<string, {
    readonly provider: BoundDesignAgentProvider;
    readonly models: Map<string, BoundDesignAgentModel>;
    readonly modelsById: Map<string, BoundDesignAgentModel>;
  }>();
  for (const entry of entries) {
    let accumulated = byProviderId.get(entry.provider.providerId);
    if (accumulated === undefined) {
      accumulated = { provider: entry.provider, models: new Map(), modelsById: new Map() };
      byProviderId.set(entry.provider.providerId, accumulated);
    } else if (canonicalJson(accumulated.provider) !== canonicalJson(entry.provider)) {
      productionAgentReject(
        "INVALID_ARGUMENT",
        "AGENT_PRODUCTION_MODEL_POLICY_INVALID",
        "A production model policy assigns conflicting descriptors to one provider ID"
      );
    }
    for (const model of entry.models) {
      if (model.provider !== entry.provider.providerId) {
        productionAgentReject(
          "INVALID_ARGUMENT",
          "AGENT_PRODUCTION_MODEL_POLICY_INVALID",
          "A production model policy assigns a model to a different provider"
        );
      }
      const sameModelId = accumulated.modelsById.get(model.model);
      if (
        sameModelId !== undefined &&
        canonicalJson(sameModelId) !== canonicalJson(model)
      ) {
        productionAgentReject(
          "POLICY_DENIED",
          "AGENT_PRODUCTION_MODEL_VERSION_AMBIGUOUS",
          "One provider cannot approve multiple versions for the same model ID across family anchors"
        );
      }
      const key = canonicalJson(model);
      accumulated.models.set(key, model);
      accumulated.modelsById.set(model.model, model);
    }
  }
  const providers = [...byProviderId.values()]
    .map(({ provider, models }) => deepFreezeProductionValue({
      provider,
      models: Object.freeze([...models.values()].sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right), "en-US")
      ))
    }))
    .sort((left, right) => canonicalJson(left.provider).localeCompare(
      canonicalJson(right.provider),
      "en-US"
    ));
  const payload = deepFreezeProductionValue({
    schemaVersion: DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA,
    providers: Object.freeze(providers)
  });
  return deepFreezeProductionValue({
    ...payload,
    identity: Object.freeze(canonicalIdentity(payload, DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA))
  });
};

import { describe, expect, it } from "vitest";

import { canonicalIdentity } from "../../src/core/canonical.js";
import {
  DEFAULT_DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY,
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_DESCRIPTOR_SCHEMA,
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA,
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA,
  DESIGN_AGENT_OUTDATED_VALIDATOR_IDS,
  DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS,
  DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
  DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE,
  DESIGN_AGENT_VALIDATOR_DOES_NOT_ESTABLISH,
  DESIGN_AGENT_VALIDATOR_ESTABLISHES,
  createDefaultDesignAgentDeterministicValidatorRegistry,
  createDesignAgentDeterministicValidatorRegistry
} from "../../src/agents/deterministic-validator-registry.js";

const OPTIONAL_VALIDATOR_ID = "fixture.optional-structured-reference-validator.v1";

const baseConfiguration = (): {
  registrations: {
    validatorId: string;
    implementationVersion: string;
    scope: typeof DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE;
    applicability: { stage: string; role: string }[];
  }[];
  mandatoryCoverage: {
    stage: string;
    role: string;
    validatorIds: string[];
  }[];
} => ({
  registrations: [{
    validatorId: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
    implementationVersion: "1.0.0",
    scope: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE,
    applicability: DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS.map((entry) => ({ ...entry }))
  }],
  mandatoryCoverage: DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS.map((entry) => ({
    ...entry,
    validatorIds: [DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID]
  }))
});

const configurationWithOptionalValidator = () => {
  const configuration = baseConfiguration();
  configuration.registrations.push({
    validatorId: OPTIONAL_VALIDATOR_ID,
    implementationVersion: "2026.09.05",
    scope: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE,
    applicability: [{ stage: "system_architecture", role: "system_architect" }]
  });
  return configuration;
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

describe("host-owned deterministic validator registry", () => {
  it("registers only the honest Phase-A scope and binds a deeply frozen snapshot", () => {
    const registry = createDefaultDesignAgentDeterministicValidatorRegistry();
    const snapshot = registry.snapshot();
    const descriptor = snapshot.validators[0]!;

    expect(registry.authority).toBe("host_owned_workflow_policy");
    expect(registry.registeredValidatorIds()).toStrictEqual([
      DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID
    ]);
    expect(descriptor).toMatchObject({
      schemaVersion: DESIGN_AGENT_DETERMINISTIC_VALIDATOR_DESCRIPTOR_SCHEMA,
      validatorId: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
      implementationVersion: "1.0.0",
      scope: "closed_schema_and_reference_integrity_only",
      authority: "host_owned_scope_limited_deterministic_validator",
      establishes: DESIGN_AGENT_VALIDATOR_ESTABLISHES,
      doesNotEstablish: DESIGN_AGENT_VALIDATOR_DOES_NOT_ESTABLISH
    });
    expect(descriptor.doesNotEstablish).toEqual(expect.arrayContaining([
      "electrical_correctness",
      "whole_design_validation",
      "evidence_lifecycle_transition",
      "approval",
      "qualification",
      "release"
    ]));
    expect(descriptor.establishes).toStrictEqual([
      "closed_proposal_schema",
      "stage_role_binding",
      "role_proposal_kind_binding",
      "identifier_uniqueness",
      "closed_requirement_reference_resolution",
      "closed_practice_reference_resolution",
      "closed_target_reference_resolution",
      "narrative_structured_identifier_binding"
    ]);
    expect(descriptor.establishes).not.toEqual(expect.arrayContaining([
      "electrical_correctness",
      "whole_design_validation",
      "native_tool_execution",
      "physical_validation",
      "evidence_lifecycle_transition",
      "approval",
      "qualification",
      "release"
    ]));
    expect(descriptor.establishes.filter((claim) =>
      (descriptor.doesNotEstablish as readonly string[]).includes(claim)
    )).toStrictEqual([]);
    expect(deeplyFrozen(registry)).toBe(true);
    expect(deeplyFrozen(snapshot)).toBe(true);

    const { identity: descriptorIdentity, ...descriptorPayload } = descriptor;
    expect(descriptorIdentity).toStrictEqual(canonicalIdentity(
      descriptorPayload,
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_DESCRIPTOR_SCHEMA
    ));
    const { identity: registryIdentity, ...registryPayload } = snapshot;
    expect(registryIdentity).toStrictEqual(canonicalIdentity(
      registryPayload,
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA
    ));
    expect(DEFAULT_DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY.snapshot())
      .toStrictEqual(snapshot);
  });

  it("owns complete mandatory coverage for exactly the eight post-approval stage/role pairs", () => {
    const registry = createDefaultDesignAgentDeterministicValidatorRegistry();

    expect(registry.snapshot().mandatoryCoverage).toHaveLength(8);
    for (const pair of DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS) {
      expect(registry.mandatoryValidatorIds(pair.stage, pair.role)).toStrictEqual([
        DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID
      ]);
      expect(registry.resolve(
        DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
        pair.stage,
        pair.role
      ).validatorId).toBe(DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID);
    }
    expect(() => registry.mandatoryValidatorIds("requirements", "requirements_analyst"))
      .toThrow(expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_POLICY_NOT_CONFIGURED"
      }));
  });

  it("unions host policy with model requests without allowing an empty subset to remove coverage", () => {
    const registry = createDesignAgentDeterministicValidatorRegistry(
      configurationWithOptionalValidator()
    );
    const noRequests = registry.plan({
      stage: "system_architecture",
      role: "system_architect",
      requestedValidatorIds: []
    });
    expect(noRequests.requestedValidatorIds).toStrictEqual([]);
    expect(noRequests.mandatoryValidatorIds).toStrictEqual([
      DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID
    ]);
    expect(noRequests.validatorIds).toStrictEqual([
      DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID
    ]);
    expect(noRequests.validators[0]!.selection).toBe("host_mandatory");

    const advisoryRequest = registry.plan({
      stage: "system_architecture",
      role: "system_architect",
      requestedValidatorIds: [OPTIONAL_VALIDATOR_ID]
    });
    expect(advisoryRequest.mandatoryValidatorIds).toStrictEqual(
      noRequests.mandatoryValidatorIds
    );
    expect(advisoryRequest.validatorIds).toStrictEqual([
      DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
      OPTIONAL_VALIDATOR_ID
    ].sort());
    expect(advisoryRequest.validators).toEqual(expect.arrayContaining([
      expect.objectContaining({
        validatorId: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
        selection: "host_mandatory"
      }),
      expect.objectContaining({
        validatorId: OPTIONAL_VALIDATOR_ID,
        selection: "model_requested"
      })
    ]));
    expect(deeplyFrozen(advisoryRequest)).toBe(true);
    const { identity, ...payload } = advisoryRequest;
    expect(identity).toStrictEqual(canonicalIdentity(
      payload,
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA
    ));

    const redundantRequest = registry.plan({
      stage: "system_architecture",
      role: "system_architect",
      requestedValidatorIds: [DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID]
    });
    expect(redundantRequest.validatorIds).toStrictEqual(noRequests.validatorIds);
    expect(redundantRequest.validators[0]!.selection)
      .toBe("host_mandatory_and_model_requested");
  });

  it("rejects stale and unregistered IDs instead of inventing aliases", () => {
    const registry = createDefaultDesignAgentDeterministicValidatorRegistry();
    const plan = (validatorId: string) => registry.plan({
      stage: "pcb_placement_routing",
      role: "pcb_layout_engineer",
      requestedValidatorIds: [validatorId]
    });

    expect(DESIGN_AGENT_OUTDATED_VALIDATOR_IDS).toContain(
      "evleda.pcb-practice-analyzer.v1"
    );
    expect(() => plan("evleda.pcb-practice-analyzer.v1")).toThrow(
      expect.objectContaining({
        code: "POLICY_DENIED",
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_OUTDATED"
      })
    );
    expect(() => registry.resolve(
      "evleda.pcb-practice-analyzer.v1",
      "pcb_placement_routing",
      "pcb_layout_engineer"
    )).toThrow(expect.objectContaining({
      failureCode: "AGENT_DETERMINISTIC_VALIDATOR_OUTDATED"
    }));
    expect(() => plan("evleda.reference-kicad.pcb-practices.v2")).toThrow(
      expect.objectContaining({
        code: "POLICY_DENIED",
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_UNREGISTERED"
      })
    );
    expect(() => plan("fixture.unknown-validator.v9")).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_UNREGISTERED"
      })
    );
  });

  it("enforces exact validator applicability and exact stage/role pairing", () => {
    const registry = createDesignAgentDeterministicValidatorRegistry(
      configurationWithOptionalValidator()
    );

    expect(() => registry.resolve(
      OPTIONAL_VALIDATOR_ID,
      "component_selection",
      "component_engineer"
    )).toThrow(expect.objectContaining({
      failureCode: "AGENT_DETERMINISTIC_VALIDATOR_NOT_APPLICABLE"
    }));
    expect(() => registry.plan({
      stage: "component_selection",
      role: "component_engineer",
      requestedValidatorIds: [OPTIONAL_VALIDATOR_ID]
    })).toThrow(expect.objectContaining({
      failureCode: "AGENT_DETERMINISTIC_VALIDATOR_NOT_APPLICABLE"
    }));
    expect(() => registry.plan({
      stage: "component_selection",
      role: "system_architect",
      requestedValidatorIds: []
    })).toThrow(expect.objectContaining({
      failureCode: "AGENT_DETERMINISTIC_VALIDATOR_STAGE_ROLE_MISMATCH"
    }));
  });

  it("rejects duplicate, incomplete, unregistered, inapplicable, and outdated host policy", () => {
    const duplicate = baseConfiguration();
    duplicate.registrations.push(structuredClone(duplicate.registrations[0]!));
    expect(() => createDesignAgentDeterministicValidatorRegistry(duplicate)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRATION_DUPLICATE"
      })
    );

    const incomplete = baseConfiguration();
    incomplete.mandatoryCoverage.pop();
    expect(() => createDesignAgentDeterministicValidatorRegistry(incomplete)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_POLICY_INCOMPLETE"
      })
    );

    const unregistered = baseConfiguration();
    unregistered.mandatoryCoverage[0]!.validatorIds = [OPTIONAL_VALIDATOR_ID];
    expect(() => createDesignAgentDeterministicValidatorRegistry(unregistered)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_POLICY_UNREGISTERED"
      })
    );

    const inapplicable = baseConfiguration();
    inapplicable.registrations[0]!.applicability.shift();
    expect(() => createDesignAgentDeterministicValidatorRegistry(inapplicable)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_POLICY_NOT_APPLICABLE"
      })
    );

    const outdated = baseConfiguration();
    outdated.registrations[0]!.validatorId = "evleda.pcb-practice-analyzer.v1";
    for (const coverage of outdated.mandatoryCoverage) {
      coverage.validatorIds = ["evleda.pcb-practice-analyzer.v1"];
    }
    expect(() => createDesignAgentDeterministicValidatorRegistry(outdated)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_OUTDATED"
      })
    );
  });

  it("snapshots before interpretation, rejects live objects, and detaches caller mutations", () => {
    const mutable = baseConfiguration();
    const registry = createDesignAgentDeterministicValidatorRegistry(mutable);
    mutable.registrations[0]!.validatorId = "fixture.changed-after-capture.v1";
    mutable.registrations[0]!.applicability.length = 0;
    mutable.mandatoryCoverage.length = 0;
    expect(registry.registeredValidatorIds()).toStrictEqual([
      DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID
    ]);
    expect(registry.snapshot().mandatoryCoverage).toHaveLength(8);

    let getterReads = 0;
    const accessor = baseConfiguration();
    Object.defineProperty(accessor.registrations[0]!, "validatorId", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID;
      }
    });
    expect(() => createDesignAgentDeterministicValidatorRegistry(accessor)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
      })
    );
    expect(getterReads).toBe(0);

    let unknownGetterReads = 0;
    const unknownAccessor = baseConfiguration();
    Object.defineProperty(unknownAccessor, "unexpected", {
      enumerable: true,
      configurable: true,
      get: () => {
        unknownGetterReads += 1;
        return true;
      }
    });
    expect(() => createDesignAgentDeterministicValidatorRegistry(unknownAccessor)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
      })
    );
    expect(unknownGetterReads).toBe(0);

    const proxied = baseConfiguration();
    proxied.registrations[0] = new Proxy(proxied.registrations[0]!, {});
    expect(() => createDesignAgentDeterministicValidatorRegistry(proxied)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
      })
    );

    const nonPlain = Object.assign(Object.create({ inherited: true }), baseConfiguration());
    expect(() => createDesignAgentDeterministicValidatorRegistry(nonPlain)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
      })
    );

    const unknown = baseConfiguration() as ReturnType<typeof baseConfiguration> & {
      unexpected: boolean;
    };
    unknown.unexpected = true;
    expect(() => createDesignAgentDeterministicValidatorRegistry(unknown)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
      })
    );

    const wide: Record<string, null> = Object.create(null) as Record<string, null>;
    for (let index = 0; index < 4_096; index += 1) wide[`field_${index}`] = null;
    expect(() => createDesignAgentDeterministicValidatorRegistry(wide)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
      })
    );

    const keyHeavy: Record<string, null> = Object.create(null) as Record<string, null>;
    keyHeavy[`x${"a".repeat(256 * 1_024)}`] = null;
    expect(() => createDesignAgentDeterministicValidatorRegistry(keyHeavy)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
      })
    );

    const namedArray = baseConfiguration();
    let namedArrayGetterReads = 0;
    Object.defineProperty(namedArray.registrations, "named_accessor", {
      enumerable: true,
      configurable: true,
      get: () => {
        namedArrayGetterReads += 1;
        return null;
      }
    });
    for (let index = 0; index < 4_096; index += 1) {
      Object.defineProperty(namedArray.registrations, `named_${index}`, {
        value: null,
        enumerable: true,
        configurable: true
      });
    }
    expect(() => createDesignAgentDeterministicValidatorRegistry(namedArray)).toThrow(
      expect.objectContaining({
        failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
      })
    );
    expect(namedArrayGetterReads).toBe(0);

    const metadataHeavy = baseConfiguration();
    let hiddenGetterReads = 0;
    for (let index = 0; index < 4_096; index += 1) {
      Object.defineProperty(metadataHeavy, `hidden_${index}`, {
        enumerable: false,
        configurable: true,
        get: () => {
          hiddenGetterReads += 1;
          return null;
        }
      });
      Object.defineProperty(metadataHeavy.registrations, Symbol(`metadata_${index}`), {
        enumerable: true,
        configurable: true,
        get: () => {
          hiddenGetterReads += 1;
          return null;
        }
      });
    }
    expect(createDesignAgentDeterministicValidatorRegistry(metadataHeavy).snapshot())
      .toStrictEqual(createDesignAgentDeterministicValidatorRegistry(baseConfiguration()).snapshot());
    expect(hiddenGetterReads).toBe(0);
  });

  it("rejects inherited enumerable input without reading an inherited accessor", () => {
    const configuration = baseConfiguration();
    const inheritedKey = "__evleda_validator_registry_inherited_test__";
    let getterReads = 0;
    let captured: unknown;
    Object.defineProperty(Object.prototype, inheritedKey, {
      configurable: true,
      enumerable: true,
      get: () => {
        getterReads += 1;
        throw new Error("inherited accessor must not be read");
      }
    });
    try {
      try {
        createDesignAgentDeterministicValidatorRegistry(configuration);
      } catch (error) {
        captured = error;
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, inheritedKey);
    }

    expect(captured).toMatchObject({
      failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
    });
    expect(getterReads).toBe(0);
  });

  it("keeps configuration and plan shapes closed and canonical ordering deterministic", () => {
    const first = configurationWithOptionalValidator();
    const second = structuredClone(first);
    second.registrations.reverse();
    second.registrations.find((registration) =>
      registration.validatorId === DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID
    )!.applicability.reverse();
    second.mandatoryCoverage.reverse();
    expect(createDesignAgentDeterministicValidatorRegistry(first).snapshot())
      .toStrictEqual(createDesignAgentDeterministicValidatorRegistry(second).snapshot());

    const registry = createDefaultDesignAgentDeterministicValidatorRegistry();
    expect(() => registry.plan({
      stage: "system_architecture",
      role: "system_architect",
      requestedValidatorIds: [
        DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
        DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID
      ]
    })).toThrow(expect.objectContaining({
      failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REQUEST_DUPLICATE"
    }));
    expect(() => registry.plan({
      stage: "system_architecture",
      role: "system_architect",
      requestedValidatorIds: [],
      unexpected: true
    } as unknown as Parameters<typeof registry.plan>[0])).toThrow(expect.objectContaining({
      failureCode: "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID"
    }));
  });
});

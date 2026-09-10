import { describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { parseRequirements } from "../../src/core/requirements.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_RESULT_SCHEMA,
  DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA
} from "../../src/agents/contracts.js";
import {
  createProvisionPinnedSystemArchitectureDecisionCompiler,
  validateAndSnapshotSystemArchitectureIr,
  validateAndSnapshotSystemArchitectureDecisionRegistry,
  validateAndSnapshotSystemArchitectureOptionCatalog,
  validateAndSnapshotSystemArchitectureTopologyCatalog
} from "../../src/agents/system-architecture-decision-compiler.js";
import {
  SYSTEM_ARCHITECTURE_APPROVAL_IDENTITY_SCHEMA,
  SYSTEM_ARCHITECTURE_DECISION_BINDING_SCHEMA,
  SYSTEM_ARCHITECTURE_DECISION_COMPILATION_SCHEMA,
  SYSTEM_ARCHITECTURE_DECISION_OPERATIONS,
  SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA,
  SYSTEM_ARCHITECTURE_GRAPH_SCHEMA,
  SYSTEM_ARCHITECTURE_IR_SCHEMA,
  SYSTEM_ARCHITECTURE_MANDATORY_VALIDATOR_IDS,
  SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA,
  SYSTEM_ARCHITECTURE_PORT_TYPES,
  SYSTEM_ARCHITECTURE_PROPOSAL_RESOLUTION_SCHEMA,
  SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA,
  type SystemArchitectureDecisionCompiler
} from "../../src/agents/system-architecture-decision-contract.js";
import {
  PCB_ENGINEERING_PRACTICE_CATALOG,
  PCB_ENGINEERING_PRACTICE_SCHEMA
} from "../../src/knowledge/pcb-engineering-practices.js";

type MutableRecord = Record<string, any>;

const PROMPT = `
Build a two-channel brushed motor controller for a 7-16.8 V DC battery.
Each motor is limited to 0.5 A RMS. Provide USB-C, CAN, UART, I2C, SPI,
two quadrature encoders, and SWD programming.
`;

const textOrder = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sortStrings = (values: string[]): void => { values.sort(textOrder); };
const tupleKey = (value: MutableRecord): string =>
  `${value.trigger}\u0000${value.action}\u0000${value.mechanism}\u0000${value.releaseCondition}`;

const normalizeFixturePayload = (record: MutableRecord): void => {
  if (record.schemaVersion === SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA) {
    record.options.sort((left: MutableRecord, right: MutableRecord) => textOrder(left.id, right.id));
    for (const option of record.options) {
      option.portTemplates.sort((left: MutableRecord, right: MutableRecord) => textOrder(left.key, right.key));
      for (const port of option.portTemplates) {
        sortStrings(port.compatibilityParameterKeys);
        port.allowedSafeStateTuples.sort((left: MutableRecord, right: MutableRecord) =>
          textOrder(tupleKey(left), tupleKey(right)));
      }
      option.parameterDomains.sort((left: MutableRecord, right: MutableRecord) => textOrder(
        `${left.targetKind}\u0000${left.targetTemplateKey ?? ""}\u0000${left.key}`,
        `${right.targetKind}\u0000${right.targetTemplateKey ?? ""}\u0000${right.key}`
      ));
      for (const domain of option.parameterDomains) {
        domain.allowedRequirementSources.sort((left: MutableRecord, right: MutableRecord) => textOrder(
          `${left.normalizedConstraintKey}\u0000${left.category}\u0000${left.priority}`,
          `${right.normalizedConstraintKey}\u0000${right.category}\u0000${right.priority}`
        ));
      }
      option.requiredPractices.sort((left: MutableRecord, right: MutableRecord) =>
        textOrder(left.practiceId, right.practiceId));
      for (const practice of option.requiredPractices) {
        sortStrings(practice.allowedTargetKinds);
        sortStrings(practice.allowedPathKinds);
      }
    }
  } else if (record.schemaVersion === SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA) {
    record.topologies.sort((left: MutableRecord, right: MutableRecord) => textOrder(left.id, right.id));
    for (const topology of record.topologies) {
      topology.roles.sort((left: MutableRecord, right: MutableRecord) => textOrder(left.id, right.id));
      topology.edges.sort((left: MutableRecord, right: MutableRecord) => textOrder(left.id, right.id));
      topology.pathPolicies.sort((left: MutableRecord, right: MutableRecord) => textOrder(left.id, right.id));
      topology.safeStatePolicies.sort((left: MutableRecord, right: MutableRecord) => textOrder(
        `${left.roleId}\u0000${left.portTemplateKey}\u0000${tupleKey(left)}`,
        `${right.roleId}\u0000${right.portTemplateKey}\u0000${tupleKey(right)}`
      ));
      topology.requirementAllocationPolicies.sort((left: MutableRecord, right: MutableRecord) =>
        textOrder(`${left.category}\u0000${left.priority}`, `${right.category}\u0000${right.priority}`));
      for (const role of topology.roles) sortStrings(role.allowedOptionIds);
      for (const edge of topology.edges) sortStrings(edge.requiredPathPolicyIds);
      for (const policy of topology.requirementAllocationPolicies) {
        sortStrings(policy.allowedTargetKinds);
        sortStrings(policy.allowedTopologyRoleIds);
        sortStrings(policy.allowedPathKinds);
      }
    }
  } else if (record.schemaVersion === SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA) {
    sortStrings(record.enabledOperations);
    record.validators.sort((left: MutableRecord, right: MutableRecord) =>
      textOrder(left.validatorId, right.validatorId));
  } else if (record.schemaVersion === SYSTEM_ARCHITECTURE_IR_SCHEMA) {
    record.selectedOptions.sort((left: MutableRecord, right: MutableRecord) => textOrder(left.optionId, right.optionId));
    for (const key of ["nodes", "ports", "connections", "allocations", "parameters", "safeStates", "paths", "practiceAllocations"]) {
      record[key].sort((left: MutableRecord, right: MutableRecord) => textOrder(left.id, right.id));
    }
    for (const key of ["nodes", "ports", "connections", "parameters", "safeStates", "paths"]) {
      for (const entity of record[key]) sortStrings(entity.requirementIds);
    }
  }
};

const identified = <Value extends MutableRecord>(payload: Value): Value & { identity: unknown } => {
  const normalized = structuredClone(payload) as Value;
  normalizeFixturePayload(normalized);
  return {
    ...normalized,
    identity: canonicalIdentity(normalized, normalized.schemaVersion)
  };
};

const refreshIdentity = (record: MutableRecord): void => {
  normalizeFixturePayload(record);
  const payload = structuredClone(record);
  delete payload.identity;
  record.identity = canonicalIdentity(payload, record.schemaVersion);
};

const requirementAllocations = (
  entities: readonly { kind: string; id: string; requirementIds: readonly string[] }[]
): MutableRecord[] => {
  let ordinal = 0;
  return entities.flatMap((entity) => entity.requirementIds.map((requirementId) => ({
    id: `allocation_${String(++ordinal).padStart(3, "0")}`,
    requirementId,
    targetKind: entity.kind,
    targetId: entity.id
  })));
};

interface Fixture {
  requirements: MutableRecord;
  approval: MutableRecord;
  optionCatalog: MutableRecord;
  topologyCatalog: MutableRecord;
  registry: MutableRecord;
  ir: MutableRecord;
  resolution: MutableRecord;
  receiptId: string;
  ids: {
    power: string;
    channels: string;
    motorCurrent: string;
    communication: readonly string[];
    sensor: string;
  };
}

const makeFixture = (): Fixture => {
  const parsed = parseRequirements(PROMPT).document;
  const requirements = {
    ...structuredClone(parsed),
    approvalId: "approval_requirements_001"
  } as MutableRecord;
  const byCategory = (category: string) =>
    requirements.requirements.filter((entry: MutableRecord) => entry.category === category);
  const power = byCategory("power")[0].id as string;
  const actuator = byCategory("actuator") as MutableRecord[];
  const channels = actuator.find((entry) => entry.normalizedValue?.endsWith(":channels"))!.id as string;
  const motorCurrent = actuator.find((entry) => entry.normalizedValue?.includes(":mA:"))!.id as string;
  const communication = byCategory("communication").map((entry: MutableRecord) => entry.id as string);
  const sensor = byCategory("sensor")[0].id as string;
  const approval = {
    id: requirements.approvalId,
    kind: "requirements",
    projectId: "project_architecture_fixture",
    runId: "run_architecture_fixture",
    subjectDigest: requirements.identity.digest,
    policyVersion: "fixture-policy-v1",
    actor: {
      type: "human",
      id: "reviewer_fixture",
      displayName: "Fixture Reviewer",
      role: "requirements_reviewer"
    },
    scope: "Approve the exact parser-derived requirements document for architecture compilation.",
    rationale: "Focused deterministic compiler fixture.",
    createdAt: "2026-09-04T00:00:00.000Z",
    expiresAt: "2027-09-04T00:00:00.000Z"
  } as MutableRecord;
  const practiceId = PCB_ENGINEERING_PRACTICE_CATALOG.rules[0]!.id;
  const practice = {
    practiceId,
    scope: "per_node",
    allowedTargetKinds: ["node"],
    allowedPathKinds: []
  };
  const voltageDomain = (targetTemplateKey: string) => ({
    key: "voltage",
    targetKind: "port",
    targetTemplateKey,
    unit: "millivolt",
    minimum: 0,
    maximum: 30_000,
    step: 1,
    required: true,
    allowedRequirementSources: [{
      normalizedConstraintKey: "input_voltage_max_mv",
      category: "power",
      priority: "must"
    }]
  });
  const optionCatalog = identified({
    schemaVersion: SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA,
    options: [
      {
        id: "battery_option",
        nodeKind: "power_source",
        portTemplates: [{
          key: "power_out",
          direction: "output",
          type: "power_dc",
          protocol: "none",
          minimumConnections: 2,
          maximumConnections: 2,
          compatibilityParameterKeys: ["voltage"],
          allowedSafeStateTuples: []
        }],
        parameterDomains: [voltageDomain("power_out")],
        requiredPractices: [practice]
      },
      {
        id: "controller_option",
        nodeKind: "controller",
        portTemplates: [
          {
            key: "power",
            direction: "input",
            type: "power_dc",
            protocol: "none",
            minimumConnections: 1,
            maximumConnections: 1,
            compatibilityParameterKeys: ["voltage"],
            allowedSafeStateTuples: []
          },
          {
            key: "enable",
            direction: "output",
            type: "control",
            protocol: "pwm",
            minimumConnections: 1,
            maximumConnections: 1,
            compatibilityParameterKeys: [],
            allowedSafeStateTuples: []
          }
        ],
        parameterDomains: [voltageDomain("power")],
        requiredPractices: [practice]
      },
      {
        id: "driver_option",
        nodeKind: "actuator_driver",
        portTemplates: [
          {
            key: "power",
            direction: "input",
            type: "power_dc",
            protocol: "none",
            minimumConnections: 1,
            maximumConnections: 1,
            compatibilityParameterKeys: ["voltage"],
            allowedSafeStateTuples: []
          },
          {
            key: "enable",
            direction: "input",
            type: "control",
            protocol: "pwm",
            minimumConnections: 1,
            maximumConnections: 1,
            compatibilityParameterKeys: [],
            allowedSafeStateTuples: [
              {
                trigger: "fault",
                action: "disable",
                mechanism: "hardware_bias",
                releaseCondition: "manual_reset"
              },
              {
                trigger: "reset",
                action: "drive_low",
                mechanism: "power_domain_default",
                releaseCondition: "validated_command"
              }
            ]
          }
        ],
        parameterDomains: [
          voltageDomain("power"),
          {
            key: "current_rms",
            targetKind: "port",
            targetTemplateKey: "power",
            unit: "milliampere",
            minimum: 0,
            maximum: 10_000,
            step: 1,
            required: true,
            allowedRequirementSources: [{
              normalizedConstraintKey: "motor_current_rms_ma",
              category: "actuator",
              priority: "must"
            }]
          }
        ],
        requiredPractices: [practice]
      }
    ]
  });
  const topologyCatalog = identified({
    schemaVersion: SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA,
    topologies: [{
      id: "motor_controller_topology",
      roles: [
        { id: "source", allowedOptionIds: ["battery_option"], minimumInstances: 1, maximumInstances: 1 },
        { id: "control", allowedOptionIds: ["controller_option"], minimumInstances: 1, maximumInstances: 1 },
        { id: "drive", allowedOptionIds: ["driver_option"], minimumInstances: 1, maximumInstances: 1 }
      ],
      edges: [
        {
          id: "edge_power_control",
          driverRoleId: "source",
          driverPortTemplateKey: "power_out",
          receiverRoleId: "control",
          receiverPortTemplateKey: "power",
          type: "power_dc",
          protocol: "none",
          minimumConnections: 1,
          maximumConnections: 1,
          maximumFanoutPerDriverPort: 1,
          maximumFaninPerReceiverPort: 1,
          requiredPathPolicyIds: ["policy_power_control"]
        },
        {
          id: "edge_power_drive",
          driverRoleId: "source",
          driverPortTemplateKey: "power_out",
          receiverRoleId: "drive",
          receiverPortTemplateKey: "power",
          type: "power_dc",
          protocol: "none",
          minimumConnections: 1,
          maximumConnections: 1,
          maximumFanoutPerDriverPort: 1,
          maximumFaninPerReceiverPort: 1,
          requiredPathPolicyIds: ["policy_power_drive"]
        },
        {
          id: "edge_enable",
          driverRoleId: "control",
          driverPortTemplateKey: "enable",
          receiverRoleId: "drive",
          receiverPortTemplateKey: "enable",
          type: "control",
          protocol: "pwm",
          minimumConnections: 1,
          maximumConnections: 1,
          maximumFanoutPerDriverPort: 1,
          maximumFaninPerReceiverPort: 1,
          requiredPathPolicyIds: ["policy_enable"]
        }
      ],
      pathPolicies: [
        {
          id: "policy_power_control",
          kind: "power_delivery",
          type: "power_dc",
          protocol: "none",
          start: { roleId: "source", portTemplateKey: "power_out" },
          end: { roleId: "control", portTemplateKey: "power" },
          orderedEdgeTemplateIds: ["edge_power_control"],
          minimumPaths: 1,
          maximumPaths: 1
        },
        {
          id: "policy_power_drive",
          kind: "power_delivery",
          type: "power_dc",
          protocol: "none",
          start: { roleId: "source", portTemplateKey: "power_out" },
          end: { roleId: "drive", portTemplateKey: "power" },
          orderedEdgeTemplateIds: ["edge_power_drive"],
          minimumPaths: 1,
          maximumPaths: 1
        },
        {
          id: "policy_enable",
          kind: "control",
          type: "control",
          protocol: "pwm",
          start: { roleId: "control", portTemplateKey: "enable" },
          end: { roleId: "drive", portTemplateKey: "enable" },
          orderedEdgeTemplateIds: ["edge_enable"],
          minimumPaths: 1,
          maximumPaths: 1
        }
      ],
      safeStatePolicies: [{
        roleId: "drive",
        portTemplateKey: "enable",
        trigger: "fault",
        action: "disable",
        mechanism: "hardware_bias",
        releaseCondition: "manual_reset",
        required: true
      }],
      requirementAllocationPolicies: [
        {
          category: "power",
          priority: "must",
          allowedTargetKinds: ["node", "port", "connection", "parameter", "path"],
          allowedTopologyRoleIds: ["source", "control", "drive"],
          allowedPathKinds: ["power_delivery"],
          minimumAllocations: 1,
          maximumAllocations: 256
        },
        {
          category: "actuator",
          priority: "must",
          allowedTargetKinds: ["node", "port", "connection", "parameter", "safe_state", "path"],
          allowedTopologyRoleIds: ["control", "drive"],
          allowedPathKinds: ["control"],
          minimumAllocations: 1,
          maximumAllocations: 256
        },
        {
          category: "communication",
          priority: "must",
          allowedTargetKinds: ["node"],
          allowedTopologyRoleIds: ["control"],
          allowedPathKinds: [],
          minimumAllocations: 1,
          maximumAllocations: 32
        },
        {
          category: "sensor",
          priority: "must",
          allowedTargetKinds: ["node"],
          allowedTopologyRoleIds: ["control"],
          allowedPathKinds: [],
          minimumAllocations: 1,
          maximumAllocations: 32
        }
      ]
    }]
  });
  const registry = identified({
    schemaVersion: SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA,
    enabledOperations: [...SYSTEM_ARCHITECTURE_DECISION_OPERATIONS],
    compiler: {
      compilerId: "evleda.system-architecture.decision-compiler.v1",
      implementationVersion: "1.0.0",
      implementationContentIdentity: contentIdentity("system-architecture-compiler-fixture-v1")
    },
    validators: SYSTEM_ARCHITECTURE_MANDATORY_VALIDATOR_IDS.map((validatorId) => ({
      validatorId,
      implementationVersion: "1.0.0",
      implementationContentIdentity: contentIdentity(`fixture:${validatorId}:v1`)
    }))
  });
  const nodes = [
    { id: "node_battery", topologyRoleId: "source", optionId: "battery_option", requirementIds: [power] },
    {
      id: "node_controller",
      topologyRoleId: "control",
      optionId: "controller_option",
      requirementIds: [power, channels, motorCurrent, ...communication, sensor].sort()
    },
    {
      id: "node_driver",
      topologyRoleId: "drive",
      optionId: "driver_option",
      requirementIds: [power, channels, motorCurrent].sort()
    }
  ];
  const ports = [
    {
      id: "port_battery_out",
      nodeId: "node_battery",
      templateKey: "power_out",
      direction: "output",
      type: "power_dc",
      protocol: "none",
      requirementIds: [power]
    },
    {
      id: "port_controller_power",
      nodeId: "node_controller",
      templateKey: "power",
      direction: "input",
      type: "power_dc",
      protocol: "none",
      requirementIds: [power]
    },
    {
      id: "port_controller_enable",
      nodeId: "node_controller",
      templateKey: "enable",
      direction: "output",
      type: "control",
      protocol: "pwm",
      requirementIds: [channels, motorCurrent].sort()
    },
    {
      id: "port_driver_power",
      nodeId: "node_driver",
      templateKey: "power",
      direction: "input",
      type: "power_dc",
      protocol: "none",
      requirementIds: [power, motorCurrent].sort()
    },
    {
      id: "port_driver_enable",
      nodeId: "node_driver",
      templateKey: "enable",
      direction: "input",
      type: "control",
      protocol: "pwm",
      requirementIds: [channels, motorCurrent].sort()
    }
  ];
  const connections = [
    {
      id: "connection_power_controller",
      edgeTemplateId: "edge_power_control",
      type: "power_dc",
      protocol: "none",
      driverPortId: "port_battery_out",
      receiverPortId: "port_controller_power",
      requirementIds: [power]
    },
    {
      id: "connection_power_driver",
      edgeTemplateId: "edge_power_drive",
      type: "power_dc",
      protocol: "none",
      driverPortId: "port_battery_out",
      receiverPortId: "port_driver_power",
      requirementIds: [power]
    },
    {
      id: "connection_enable",
      edgeTemplateId: "edge_enable",
      type: "control",
      protocol: "pwm",
      driverPortId: "port_controller_enable",
      receiverPortId: "port_driver_enable",
      requirementIds: [channels, motorCurrent].sort()
    }
  ];
  const parameters = [
    {
      id: "parameter_battery_voltage",
      nodeId: "node_battery",
      optionId: "battery_option",
      targetKind: "port",
      targetId: "port_battery_out",
      parameterKey: "voltage",
      requirementIds: [power],
      source: { valueSource: "approved_requirement", requirementId: power, normalizedConstraintKey: "input_voltage_max_mv" }
    },
    {
      id: "parameter_controller_voltage",
      nodeId: "node_controller",
      optionId: "controller_option",
      targetKind: "port",
      targetId: "port_controller_power",
      parameterKey: "voltage",
      requirementIds: [power],
      source: { valueSource: "approved_requirement", requirementId: power, normalizedConstraintKey: "input_voltage_max_mv" }
    },
    {
      id: "parameter_driver_voltage",
      nodeId: "node_driver",
      optionId: "driver_option",
      targetKind: "port",
      targetId: "port_driver_power",
      parameterKey: "voltage",
      requirementIds: [power],
      source: { valueSource: "approved_requirement", requirementId: power, normalizedConstraintKey: "input_voltage_max_mv" }
    },
    {
      id: "parameter_driver_current",
      nodeId: "node_driver",
      optionId: "driver_option",
      targetKind: "port",
      targetId: "port_driver_power",
      parameterKey: "current_rms",
      requirementIds: [motorCurrent],
      source: { valueSource: "approved_requirement", requirementId: motorCurrent, normalizedConstraintKey: "motor_current_rms_ma" }
    }
  ];
  const safeStates = [{
    id: "state_driver_fault_bias",
    nodeId: "node_driver",
    targetPortId: "port_driver_enable",
    trigger: "fault",
    action: "disable",
    mechanism: "hardware_bias",
    releaseCondition: "manual_reset",
    requirementIds: [motorCurrent]
  }];
  const paths = [
    {
      id: "path_power_controller",
      pathPolicyId: "policy_power_control",
      kind: "power_delivery",
      type: "power_dc",
      protocol: "none",
      startPortId: "port_battery_out",
      endPortId: "port_controller_power",
      orderedConnectionIds: ["connection_power_controller"],
      requirementIds: [power]
    },
    {
      id: "path_power_driver",
      pathPolicyId: "policy_power_drive",
      kind: "power_delivery",
      type: "power_dc",
      protocol: "none",
      startPortId: "port_battery_out",
      endPortId: "port_driver_power",
      orderedConnectionIds: ["connection_power_driver"],
      requirementIds: [power]
    },
    {
      id: "path_enable",
      pathPolicyId: "policy_enable",
      kind: "control",
      type: "control",
      protocol: "pwm",
      startPortId: "port_controller_enable",
      endPortId: "port_driver_enable",
      orderedConnectionIds: ["connection_enable"],
      requirementIds: [channels, motorCurrent].sort()
    }
  ];
  const allocations = requirementAllocations([
    ...nodes.map(({ id, requirementIds }) => ({ kind: "node", id, requirementIds })),
    ...ports.map(({ id, requirementIds }) => ({ kind: "port", id, requirementIds })),
    ...connections.map(({ id, requirementIds }) => ({ kind: "connection", id, requirementIds })),
    ...parameters.map(({ id, requirementIds }) => ({ kind: "parameter", id, requirementIds })),
    ...safeStates.map(({ id, requirementIds }) => ({ kind: "safe_state", id, requirementIds })),
    ...paths.map(({ id, requirementIds }) => ({ kind: "path", id, requirementIds }))
  ]);
  const ir = identified({
    schemaVersion: SYSTEM_ARCHITECTURE_IR_SCHEMA,
    stage: "system_architecture",
    role: "system_architect",
    classification: "proposal_only",
    authorityDisposition: "none",
    topologyTemplateId: "motor_controller_topology",
    requirementsIdentity: requirements.identity,
    requirementsApprovalIdentity: canonicalIdentity(approval, SYSTEM_ARCHITECTURE_APPROVAL_IDENTITY_SCHEMA),
    optionCatalogIdentity: optionCatalog.identity,
    topologyCatalogIdentity: topologyCatalog.identity,
    pcbPracticeCatalogIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
    registryIdentity: registry.identity,
    outputContractIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
    selectedOptions: [
      { optionId: "battery_option" },
      { optionId: "controller_option" },
      { optionId: "driver_option" }
    ],
    nodes,
    ports,
    connections,
    allocations,
    parameters,
    safeStates,
    paths,
    practiceAllocations: [
      { id: "practice_battery", practiceId, targetKind: "node", targetId: "node_battery" },
      { id: "practice_controller", practiceId, targetKind: "node", targetId: "node_controller" },
      { id: "practice_driver", practiceId, targetKind: "node", targetId: "node_driver" }
    ]
  });
  const replayIdentity = canonicalIdentity(
    { schemaVersion: DESIGN_AGENT_REPLAY_SCHEMA, fixture: "architecture_replay" },
    DESIGN_AGENT_REPLAY_SCHEMA
  );
  const receiptId = `replay_${replayIdentity.digest}`;
  const resolution = identified({
    schemaVersion: SYSTEM_ARCHITECTURE_PROPOSAL_RESOLUTION_SCHEMA,
    receiptId,
    replayReceiptIdentity: canonicalIdentity(
      { schemaVersion: DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA, receiptId },
      DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA
    ),
    replayIdentity,
    proposalResultIdentity: canonicalIdentity(
      { schemaVersion: DESIGN_AGENT_RESULT_SCHEMA, fixture: "architecture_result" },
      DESIGN_AGENT_RESULT_SCHEMA
    ),
    structuredProposalIdentity: canonicalIdentity(
      { schemaVersion: DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA, fixture: "architecture_structured" },
      DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA
    ),
    outputContractIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
    irIdentity: ir.identity,
    irSnapshot: ir
  });
  return {
    requirements,
    approval,
    optionCatalog,
    topologyCatalog,
    registry,
    ir,
    resolution,
    receiptId,
    ids: { power, channels, motorCurrent, communication, sensor }
  };
};

const refreshIrAndResolution = (fixture: Fixture): void => {
  fixture.ir.requirementsIdentity = fixture.requirements.identity;
  fixture.ir.requirementsApprovalIdentity = canonicalIdentity(
    fixture.approval,
    SYSTEM_ARCHITECTURE_APPROVAL_IDENTITY_SCHEMA
  );
  fixture.ir.optionCatalogIdentity = fixture.optionCatalog.identity;
  fixture.ir.topologyCatalogIdentity = fixture.topologyCatalog.identity;
  fixture.ir.registryIdentity = fixture.registry.identity;
  refreshIdentity(fixture.ir);
  fixture.resolution.irSnapshot = fixture.ir;
  fixture.resolution.irIdentity = fixture.ir.identity;
  refreshIdentity(fixture.resolution);
};

const refreshRequirementsApprovalAndBindings = (fixture: Fixture): void => {
  const requirementsPayload = structuredClone(fixture.requirements);
  delete requirementsPayload.identity;
  delete requirementsPayload.approvalId;
  fixture.requirements.identity = canonicalIdentity(requirementsPayload, "evleda.requirements.v1");
  fixture.approval.subjectDigest = fixture.requirements.identity.digest;
  refreshIrAndResolution(fixture);
};

const compilerFor = (
  fixture: Fixture,
  overrides: Partial<{
    authenticateRequirementsApproval: (approval: MutableRecord, requirements: MutableRecord) => void;
    resolveAuthenticatedProposal: (receiptId: string) => Promise<unknown>;
    expectedRegistryIdentity: MutableRecord;
  }> = {}
): SystemArchitectureDecisionCompiler => createProvisionPinnedSystemArchitectureDecisionCompiler({
  requirementsDocument: fixture.requirements,
  requirementsApproval: fixture.approval,
  optionCatalog: fixture.optionCatalog,
  topologyCatalog: fixture.topologyCatalog,
  pcbPracticeCatalog: PCB_ENGINEERING_PRACTICE_CATALOG,
  registry: fixture.registry,
  expectedIdentities: {
    requirementsIdentity: fixture.requirements.identity,
    requirementsApprovalIdentity: canonicalIdentity(
      fixture.approval,
      SYSTEM_ARCHITECTURE_APPROVAL_IDENTITY_SCHEMA
    ),
    optionCatalogIdentity: fixture.optionCatalog.identity,
    topologyCatalogIdentity: fixture.topologyCatalog.identity,
    pcbPracticeCatalogIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
    registryIdentity: overrides.expectedRegistryIdentity ?? fixture.registry.identity,
    outputContractIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY
  },
  verificationTime: "2026-09-05T00:00:00.000Z",
  authenticateRequirementsApproval: overrides.authenticateRequirementsApproval ?? ((approval, requirements) => {
    if (approval.id !== requirements.approvalId || approval.subjectDigest !== requirements.identity.digest) {
      throw new Error("not authenticated");
    }
  }),
  resolveAuthenticatedProposal: overrides.resolveAuthenticatedProposal ?? (async (receiptId) =>
    receiptId === fixture.receiptId ? fixture.resolution : undefined)
});

const issueCodes = async (fixture: Fixture): Promise<readonly string[]> =>
  (await compilerFor(fixture).compile({ receiptId: fixture.receiptId })).issues.map(({ code }) => code);

describe("provision-pinned system architecture decision compiler", () => {
  it("compiles a parser-derived, approval-authenticated, topology-constrained candidate", async () => {
    const fixture = makeFixture();
    expect(fixture.requirements.constraints).toMatchObject({
      input_voltage_max_mv: "16800",
      motor_current_rms_ma: "500"
    });
    const compiler = compilerFor(fixture);
    const compilation = await compiler.compile({ receiptId: fixture.receiptId });
    expect(compilation).toMatchObject({
      schemaVersion: SYSTEM_ARCHITECTURE_DECISION_COMPILATION_SCHEMA,
      disposition: "accepted",
      lifecycle: "candidate",
      authority: "none",
      issues: []
    });
    expect(compilation.graph).toMatchObject({
      schemaVersion: SYSTEM_ARCHITECTURE_GRAPH_SCHEMA,
      topologyTemplateId: "motor_controller_topology",
      lifecycle: "candidate",
      authority: "none"
    });
    expect(compilation.compilerImplementationContentIdentity).toStrictEqual(
      fixture.registry.compiler.implementationContentIdentity
    );
    expect(compilation.graph?.parameters.map(({ value, unit }) => ({ value, unit }))).toEqual([
      { value: 16800, unit: "millivolt" },
      { value: 16800, unit: "millivolt" },
      { value: 500, unit: "milliampere" },
      { value: 16800, unit: "millivolt" }
    ]);
    const binding = await compiler.compileBinding({ receiptId: fixture.receiptId });
    expect(binding.schemaVersion).toBe(SYSTEM_ARCHITECTURE_DECISION_BINDING_SCHEMA);
    expect(binding.requirementsSnapshot).toStrictEqual(fixture.requirements);
    expect(binding.pcbPracticeCatalogSnapshot).toStrictEqual(PCB_ENGINEERING_PRACTICE_CATALOG);
    expect(await compiler.validateBinding(binding)).toStrictEqual(binding);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.compilation.graph?.nodes)).toBe(true);
    expect(Object.isFrozen(compiler.pinnedIdentities)).toBe(true);
  });

  it("rejects request-supplied roots before invoking the opaque resolver", async () => {
    const fixture = makeFixture();
    const resolver = vi.fn(async () => fixture.resolution);
    const compiler = compilerFor(fixture, { resolveAuthenticatedProposal: resolver });
    await expect(compiler.compile({
      receiptId: fixture.receiptId,
      optionCatalog: fixture.optionCatalog,
      ir: fixture.ir,
      expectedIdentities: compiler.pinnedIdentities
    } as any)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("captures the request before awaiting the durable-style receipt resolver", async () => {
    const fixture = makeFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const compiler = compilerFor(fixture, {
      resolveAuthenticatedProposal: async () => {
        await gate;
        return fixture.resolution;
      }
    });
    const request: MutableRecord = { receiptId: fixture.receiptId };
    const pending = compiler.compile(request as any);
    request.receiptId = "replay_attacker";
    release();
    await expect(pending).resolves.toMatchObject({ disposition: "accepted" });
  });

  it("snapshots a compilation candidate before awaiting its authenticated resolver", async () => {
    const fixture = makeFixture();
    const baseline = compilerFor(fixture);
    const candidate = structuredClone(await baseline.compile({ receiptId: fixture.receiptId })) as MutableRecord;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const validator = compilerFor(fixture, {
      resolveAuthenticatedProposal: async () => {
        await gate;
        return fixture.resolution;
      }
    });
    const pending = validator.validateCompilation(candidate, { receiptId: fixture.receiptId });
    candidate.disposition = "rejected";
    release();
    await expect(pending).resolves.toMatchObject({ disposition: "accepted" });
  });

  it("rejects unreviewed safe-state Cartesian products while allowing receiver-side bias", async () => {
    const fixture = makeFixture();
    fixture.ir.safeStates[0] = {
      ...fixture.ir.safeStates[0],
      trigger: "fault",
      action: "drive_low",
      mechanism: "hardware_bias",
      releaseCondition: "validated_command"
    };
    refreshIrAndResolution(fixture);
    expect(await issueCodes(fixture)).toEqual(expect.arrayContaining([
      "SAFE_STATE_TUPLE_NOT_ALLOWED",
      "SAFE_STATE_TOPOLOGY_POLICY_MISSING"
    ]));
  });

  it("rejects contradictory actions for one port and trigger without an explicit group model", async () => {
    const runtime = makeFixture();
    runtime.ir.safeStates.push({
      ...structuredClone(runtime.ir.safeStates[0]),
      id: "state_driver_fault_contradiction",
      action: "drive_low",
      mechanism: "power_domain_default",
      releaseCondition: "validated_command"
    });
    refreshIrAndResolution(runtime);
    expect(await issueCodes(runtime)).toContain("SAFE_STATE_DUPLICATE");

    const provision = makeFixture();
    const driverOption = provision.optionCatalog.options.find(
      (option: MutableRecord) => option.id === "driver_option"
    );
    const enablePort = driverOption.portTemplates.find(
      (port: MutableRecord) => port.key === "enable"
    );
    enablePort.allowedSafeStateTuples.push({
      trigger: "fault",
      action: "drive_low",
      mechanism: "power_domain_default",
      releaseCondition: "validated_command"
    });
    provision.topologyCatalog.topologies[0].safeStatePolicies.push({
      roleId: "drive",
      portTemplateKey: "enable",
      trigger: "fault",
      action: "drive_low",
      mechanism: "power_domain_default",
      releaseCondition: "validated_command",
      required: false
    });
    refreshIdentity(provision.optionCatalog);
    refreshIdentity(provision.topologyCatalog);
    refreshIrAndResolution(provision);
    expect(() => compilerFor(provision)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("rejects path kind relabeling, mixed semantic splices, and uncovered connections", async () => {
    const relabeled = makeFixture();
    relabeled.ir.paths.find((path: MutableRecord) => path.id === "path_power_controller").kind = "control";
    refreshIrAndResolution(relabeled);
    expect(await issueCodes(relabeled)).toContain("PATH_KIND_MISMATCH");

    const spliced = makeFixture();
    const controlPath = spliced.ir.paths.find((path: MutableRecord) => path.id === "path_enable");
    controlPath.orderedConnectionIds = ["connection_power_controller", "connection_enable"];
    controlPath.startPortId = "port_battery_out";
    refreshIrAndResolution(spliced);
    expect(await issueCodes(spliced)).toEqual(expect.arrayContaining([
      "PATH_EDGE_SEQUENCE_MISMATCH",
      "PATH_ENDPOINT_MISMATCH"
    ]));

    const omitted = makeFixture();
    omitted.ir.paths = omitted.ir.paths.filter((path: MutableRecord) => path.id !== "path_power_driver");
    omitted.ir.allocations = omitted.ir.allocations.filter(
      (allocation: MutableRecord) => allocation.targetId !== "path_power_driver"
    );
    refreshIrAndResolution(omitted);
    expect(await issueCodes(omitted)).toEqual(expect.arrayContaining([
      "CONNECTION_PATH_COVERAGE_MISSING",
      "PATH_CARDINALITY_INVALID"
    ]));
  });

  it("requires a high-di/dt loop to close on the same concrete node across multi-instance roles", async () => {
    const invalidPolicy = makeFixture();
    invalidPolicy.topologyCatalog.topologies[0].pathPolicies
      .find((policy: MutableRecord) => policy.id === "policy_power_control")
      .kind = "high_di_dt_loop";
    refreshIdentity(invalidPolicy.topologyCatalog);
    refreshIrAndResolution(invalidPolicy);
    expect(() => compilerFor(invalidPolicy)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );

    const fixture = makeFixture();
    const topology = fixture.topologyCatalog.topologies[0];
    topology.roles.find((role: MutableRecord) => role.id === "drive").maximumInstances = 2;
    const driverOption = fixture.optionCatalog.options.find(
      (option: MutableRecord) => option.id === "driver_option"
    );
    for (const port of driverOption.portTemplates) {
      port.minimumConnections = 0;
    }
    driverOption.portTemplates.push(
      {
        key: "loop_out",
        direction: "output",
        type: "power_return",
        protocol: "none",
        minimumConnections: 0,
        maximumConnections: 1,
        compatibilityParameterKeys: [],
        allowedSafeStateTuples: []
      },
      {
        key: "loop_in",
        direction: "input",
        type: "power_return",
        protocol: "none",
        minimumConnections: 0,
        maximumConnections: 1,
        compatibilityParameterKeys: [],
        allowedSafeStateTuples: []
      }
    );
    topology.edges.push({
      id: "edge_high_di_dt_loop",
      driverRoleId: "drive",
      driverPortTemplateKey: "loop_out",
      receiverRoleId: "drive",
      receiverPortTemplateKey: "loop_in",
      type: "power_return",
      protocol: "none",
      minimumConnections: 1,
      maximumConnections: 1,
      maximumFanoutPerDriverPort: 1,
      maximumFaninPerReceiverPort: 1,
      requiredPathPolicyIds: ["policy_high_di_dt_loop"]
    });
    topology.pathPolicies.push({
      id: "policy_high_di_dt_loop",
      kind: "high_di_dt_loop",
      type: "power_return",
      protocol: "none",
      start: { roleId: "drive", portTemplateKey: "loop_out" },
      end: { roleId: "drive", portTemplateKey: "loop_in" },
      orderedEdgeTemplateIds: ["edge_high_di_dt_loop"],
      minimumPaths: 1,
      maximumPaths: 1
    });
    topology.requirementAllocationPolicies
      .find((policy: MutableRecord) => policy.category === "actuator")
      .allowedPathKinds.push("high_di_dt_loop");

    const firstDriver = fixture.ir.nodes.find((node: MutableRecord) => node.id === "node_driver");
    const secondDriver = {
      ...structuredClone(firstDriver),
      id: "node_driver_second"
    };
    fixture.ir.nodes.push(secondDriver);
    const newEntities: { kind: string; id: string; requirementIds: string[] }[] = [
      { kind: "node", id: secondDriver.id, requirementIds: secondDriver.requirementIds }
    ];
    const addPort = (id: string, nodeId: string, templateKey: string, direction: string, requirementIds: string[]) => {
      fixture.ir.ports.push({
        id,
        nodeId,
        templateKey,
        direction,
        type: templateKey.startsWith("loop_") ? "power_return" : templateKey === "enable" ? "control" : "power_dc",
        protocol: templateKey === "enable" ? "pwm" : "none",
        requirementIds: [...requirementIds].sort()
      });
      newEntities.push({ kind: "port", id, requirementIds });
    };
    addPort("port_driver_loop_out", "node_driver", "loop_out", "output", [fixture.ids.motorCurrent]);
    addPort("port_driver_loop_in", "node_driver", "loop_in", "input", [fixture.ids.motorCurrent]);
    addPort("port_driver_second_power", secondDriver.id, "power", "input", [fixture.ids.power, fixture.ids.motorCurrent]);
    addPort("port_driver_second_enable", secondDriver.id, "enable", "input", [fixture.ids.channels, fixture.ids.motorCurrent]);
    addPort("port_driver_second_loop_out", secondDriver.id, "loop_out", "output", [fixture.ids.motorCurrent]);
    addPort("port_driver_second_loop_in", secondDriver.id, "loop_in", "input", [fixture.ids.motorCurrent]);

    const secondParameters = [
      {
        id: "parameter_driver_second_voltage",
        nodeId: secondDriver.id,
        optionId: "driver_option",
        targetKind: "port",
        targetId: "port_driver_second_power",
        parameterKey: "voltage",
        requirementIds: [fixture.ids.power],
        source: {
          valueSource: "approved_requirement",
          requirementId: fixture.ids.power,
          normalizedConstraintKey: "input_voltage_max_mv"
        }
      },
      {
        id: "parameter_driver_second_current",
        nodeId: secondDriver.id,
        optionId: "driver_option",
        targetKind: "port",
        targetId: "port_driver_second_power",
        parameterKey: "current_rms",
        requirementIds: [fixture.ids.motorCurrent],
        source: {
          valueSource: "approved_requirement",
          requirementId: fixture.ids.motorCurrent,
          normalizedConstraintKey: "motor_current_rms_ma"
        }
      }
    ];
    fixture.ir.parameters.push(...secondParameters);
    for (const parameter of secondParameters) {
      newEntities.push({ kind: "parameter", id: parameter.id, requirementIds: parameter.requirementIds });
    }
    const secondSafeState = {
      ...structuredClone(fixture.ir.safeStates[0]),
      id: "state_driver_second_fault_bias",
      nodeId: secondDriver.id,
      targetPortId: "port_driver_second_enable"
    };
    fixture.ir.safeStates.push(secondSafeState);
    newEntities.push({ kind: "safe_state", id: secondSafeState.id, requirementIds: secondSafeState.requirementIds });
    const loopConnection = {
      id: "connection_open_high_di_dt_loop",
      edgeTemplateId: "edge_high_di_dt_loop",
      type: "power_return",
      protocol: "none",
      driverPortId: "port_driver_loop_out",
      receiverPortId: "port_driver_second_loop_in",
      requirementIds: [fixture.ids.motorCurrent]
    };
    fixture.ir.connections.push(loopConnection);
    newEntities.push({ kind: "connection", id: loopConnection.id, requirementIds: loopConnection.requirementIds });
    const loopPath = {
      id: "path_open_high_di_dt_loop",
      pathPolicyId: "policy_high_di_dt_loop",
      kind: "high_di_dt_loop",
      type: "power_return",
      protocol: "none",
      startPortId: "port_driver_loop_out",
      endPortId: "port_driver_second_loop_in",
      orderedConnectionIds: [loopConnection.id],
      requirementIds: [fixture.ids.motorCurrent]
    };
    fixture.ir.paths.push(loopPath);
    newEntities.push({ kind: "path", id: loopPath.id, requirementIds: loopPath.requirementIds });
    fixture.ir.practiceAllocations.push({
      ...structuredClone(fixture.ir.practiceAllocations.find(
        (allocation: MutableRecord) => allocation.targetId === "node_driver"
      )),
      id: "practice_driver_second",
      targetId: secondDriver.id
    });
    let allocationOrdinal = 0;
    for (const entity of newEntities) {
      for (const requirementId of entity.requirementIds) {
        fixture.ir.allocations.push({
          id: `allocation_loop_fixture_${String(++allocationOrdinal).padStart(3, "0")}`,
          requirementId,
          targetKind: entity.kind,
          targetId: entity.id
        });
      }
    }
    refreshIdentity(fixture.optionCatalog);
    refreshIdentity(fixture.topologyCatalog);
    refreshIrAndResolution(fixture);
    expect(await issueCodes(fixture)).toContain("PATH_LOOP_NOT_CLOSED");
  });

  it("rejects duplicate role instances and edge fanout beyond the reviewed topology", async () => {
    const duplicated = makeFixture();
    duplicated.ir.nodes.push({
      ...structuredClone(duplicated.ir.nodes.find((node: MutableRecord) => node.id === "node_driver")),
      id: "node_driver_second"
    });
    refreshIrAndResolution(duplicated);
    expect(await issueCodes(duplicated)).toEqual(expect.arrayContaining([
      "TOPOLOGY_ROLE_CARDINALITY_INVALID",
      "PRACTICE_UNALLOCATED"
    ]));

    const fanout = makeFixture();
    fanout.ir.connections.push({
      ...structuredClone(fanout.ir.connections.find((connection: MutableRecord) => connection.id === "connection_enable")),
      id: "connection_enable_duplicate"
    });
    refreshIrAndResolution(fanout);
    expect(await issueCodes(fanout)).toContain("CONNECTION_FANOUT_INVALID");
  });

  it("does not let duplicate semantic allocations satisfy reviewed cardinality", async () => {
    const fixture = makeFixture();
    fixture.ir.allocations.push({
      ...structuredClone(fixture.ir.allocations[0]),
      id: "allocation_semantic_duplicate"
    });
    fixture.ir.practiceAllocations.push({
      ...structuredClone(fixture.ir.practiceAllocations[0]),
      id: "practice_semantic_duplicate"
    });
    refreshIrAndResolution(fixture);
    expect(await issueCodes(fixture)).toEqual(expect.arrayContaining([
      "ALLOCATION_DUPLICATE",
      "PRACTICE_ALLOCATION_DUPLICATE"
    ]));
  });

  it("rejects safety-relevant actuator allocation solely to the power-source role", async () => {
    const fixture = makeFixture();
    for (const allocation of fixture.ir.allocations) {
      if (allocation.requirementId === fixture.ids.motorCurrent) {
        allocation.targetKind = "node";
        allocation.targetId = "node_battery";
      }
    }
    refreshIrAndResolution(fixture);
    expect(await issueCodes(fixture)).toContain("REQUIREMENT_ALLOCATION_TARGET_FORBIDDEN");
  });

  it("rejects a same-category requirement ID swap for an approved numeric constraint", async () => {
    const fixture = makeFixture();
    const driver = fixture.ir.parameters.find((parameter: MutableRecord) => parameter.id === "parameter_driver_current");
    driver.source = {
      valueSource: "approved_requirement",
      requirementId: fixture.ids.channels,
      normalizedConstraintKey: "motor_current_rms_ma"
    };
    driver.requirementIds = [fixture.ids.channels, fixture.ids.motorCurrent].sort();
    refreshIrAndResolution(fixture);
    expect(await issueCodes(fixture)).toContain("PARAMETER_CONSTRAINT_OWNER_MISMATCH");
  });

  it("rejects missing and ambiguous trusted constraint ownership during provisioning", () => {
    const missing = makeFixture();
    const driverOption = missing.optionCatalog.options.find(
      (option: MutableRecord) => option.id === "driver_option"
    );
    const currentDomain = driverOption.parameterDomains.find(
      (domain: MutableRecord) => domain.key === "current_rms"
    );
    currentDomain.allowedRequirementSources = [{
      normalizedConstraintKey: "maximum_total_current_ma",
      category: "power",
      priority: "must"
    }];
    refreshIdentity(missing.optionCatalog);
    refreshIrAndResolution(missing);
    expect(() => compilerFor(missing)).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));

    const ambiguous = makeFixture();
    const owner = ambiguous.requirements.requirements.find(
      (requirement: MutableRecord) => requirement.id === ambiguous.ids.motorCurrent
    );
    ambiguous.requirements.requirements.push({ ...structuredClone(owner), id: "req_duplicate_motor_current" });
    refreshRequirementsApprovalAndBindings(ambiguous);
    expect(() => compilerFor(ambiguous)).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it("uses the same pinned provision when validating fully rehashed bindings", async () => {
    const fixture = makeFixture();
    const compiler = compilerFor(fixture);
    const binding = structuredClone(await compiler.compileBinding({ receiptId: fixture.receiptId })) as MutableRecord;
    binding.compilation.graph.nodes[0].nodeKind = "memory";
    refreshIdentity(binding.compilation.graph);
    binding.compilation.graphIdentity = binding.compilation.graph.identity;
    refreshIdentity(binding.compilation);
    binding.compilationIdentity = binding.compilation.identity;
    refreshIdentity(binding);
    await expect(compiler.validateBinding(binding)).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
  });

  it("rejects revoked or unauthenticated approvals before any proposal resolution", () => {
    const revoked = makeFixture();
    revoked.approval.revokedAt = "2026-09-04T12:00:00.000Z";
    expect(() => compilerFor(revoked)).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));

    const unauthenticated = makeFixture();
    expect(() => compilerFor(unauthenticated, {
      authenticateRequirementsApproval: () => { throw new Error("bad signature"); }
    })).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it("freezes every exported runtime allowlist and validated identity-bearing artifact", () => {
    expect(Object.isFrozen(SYSTEM_ARCHITECTURE_PORT_TYPES)).toBe(true);
    expect(Object.isFrozen(SYSTEM_ARCHITECTURE_DECISION_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(SYSTEM_ARCHITECTURE_MANDATORY_VALIDATOR_IDS)).toBe(true);
    expect(() => ((SYSTEM_ARCHITECTURE_PORT_TYPES as any)[0] = "attacker_type")).toThrow();
    const fixture = makeFixture();
    const optionSnapshot = validateAndSnapshotSystemArchitectureOptionCatalog(fixture.optionCatalog);
    const topologySnapshot = validateAndSnapshotSystemArchitectureTopologyCatalog(
      fixture.topologyCatalog,
      fixture.optionCatalog
    );
    const irSnapshot = validateAndSnapshotSystemArchitectureIr(fixture.ir);
    expect(Object.isFrozen(optionSnapshot.identity)).toBe(true);
    expect(Object.isFrozen(optionSnapshot.options[0]?.portTemplates[0]?.allowedSafeStateTuples)).toBe(true);
    expect(Object.isFrozen(topologySnapshot.topologies[0]?.requirementAllocationPolicies)).toBe(true);
    expect(Object.isFrozen(irSnapshot.paths)).toBe(true);
  });

  it("requires the closed validator registry and binds exact implementation bytes", () => {
    const missing = makeFixture();
    missing.registry.validators.pop();
    refreshIdentity(missing.registry);
    expect(() => validateAndSnapshotSystemArchitectureDecisionRegistry(missing.registry)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );

    const duplicate = makeFixture();
    duplicate.registry.validators[1] = structuredClone(duplicate.registry.validators[0]);
    refreshIdentity(duplicate.registry);
    expect(() => validateAndSnapshotSystemArchitectureDecisionRegistry(duplicate.registry)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );

    const unknown = makeFixture();
    unknown.registry.validators[0].validatorId = "evleda.system-architecture.attacker-validator.v1";
    refreshIdentity(unknown.registry);
    expect(() => validateAndSnapshotSystemArchitectureDecisionRegistry(unknown.registry)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );

    const changed = makeFixture();
    const priorIdentity = structuredClone(changed.registry.identity);
    changed.registry.compiler.implementationContentIdentity = contentIdentity("different-compiler-bytes");
    refreshIdentity(changed.registry);
    expect(changed.registry.identity).not.toStrictEqual(priorIdentity);
    expect(() => compilerFor(changed, { expectedRegistryIdentity: priorIdentity })).toThrowError(
      expect.objectContaining({ code: "POLICY_DENIED" })
    );

    for (const target of ["compiler", "validator"] as const) {
      for (const size of [0, 64 * 1024 * 1024 + 1]) {
        const invalidSize = makeFixture();
        const identity = target === "compiler"
          ? invalidSize.registry.compiler.implementationContentIdentity
          : invalidSize.registry.validators[0].implementationContentIdentity;
        identity.size = size;
        refreshIdentity(invalidSize.registry);
        expect(() => validateAndSnapshotSystemArchitectureDecisionRegistry(invalidSize.registry)).toThrowError(
          expect.objectContaining({ code: "INVALID_ARGUMENT" })
        );
      }
    }
  });

  it("rejects oversized UTF-8 keys and aggregate primitive graphs before semantic reads", async () => {
    const keyFixture = makeFixture();
    const resolver = vi.fn(async () => keyFixture.resolution);
    const compiler = compilerFor(keyFixture, { resolveAuthenticatedProposal: resolver });
    await expect(compiler.compile({
      receiptId: keyFixture.receiptId,
      ["🔥".repeat(129)]: true
    } as any)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(resolver).not.toHaveBeenCalled();

    const budgetFixture = makeFixture();
    budgetFixture.optionCatalog.untrustedBulk = Array.from(
      { length: 70 },
      () => Array.from({ length: 4_000 }, () => true)
    );
    expect(() => compilerFor(budgetFixture)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );
  });

  it("self-validates a binding whose legal pinned requirements approach the input byte budget", async () => {
    const fixture = makeFixture();
    const template = fixture.requirements.requirements.find(
      (requirement: MutableRecord) => requirement.category === "communication"
    );
    const controller = fixture.ir.nodes.find((node: MutableRecord) => node.id === "node_controller");
    for (let index = 0; index < 200; index += 1) {
      const id = `req_bulk_communication_${String(index).padStart(3, "0")}`;
      fixture.requirements.requirements.push({
        ...structuredClone(template),
        id,
        statement: `${"x".repeat(60_000)}${String(index)}`
      });
      controller.requirementIds.push(id);
      fixture.ir.allocations.push({
        id: `allocation_bulk_${String(index).padStart(3, "0")}`,
        requirementId: id,
        targetKind: "node",
        targetId: "node_controller"
      });
    }
    refreshRequirementsApprovalAndBindings(fixture);
    const compiler = compilerFor(fixture);
    const binding = await compiler.compileBinding({ receiptId: fixture.receiptId });
    await expect(compiler.validateBinding(binding)).resolves.toStrictEqual(binding);
  });

  it("retains exact BigInt step arithmetic at safe-integer extremes", () => {
    const fixture = makeFixture();
    const domain = fixture.optionCatalog.options[0].parameterDomains[0];
    domain.minimum = -9_000_000_000_000_000;
    domain.maximum = 9_000_000_000_000_000;
    domain.step = 2;
    refreshIdentity(fixture.optionCatalog);
    refreshIrAndResolution(fixture);
    expect(() => compilerFor(fixture)).not.toThrow();

    const invalid = makeFixture();
    const invalidDomain = invalid.optionCatalog.options[0].parameterDomains[0];
    invalidDomain.minimum = -9_000_000_000_000_000;
    invalidDomain.maximum = 8_999_999_999_999_999;
    invalidDomain.step = 2;
    refreshIdentity(invalid.optionCatalog);
    refreshIrAndResolution(invalid);
    expect(() => compilerFor(invalid)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("keeps all prose outside the IR, graph, compilation, and decision binding", async () => {
    const fixture = makeFixture();
    const compiler = compilerFor(fixture);
    const binding = await compiler.compileBinding({ receiptId: fixture.receiptId });
    const forbidden = new Set(["narrative", "summary", "rationale", "command", "executable"]);
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      for (const [key, entry] of Object.entries(value)) {
        expect(forbidden.has(key)).toBe(false);
        visit(entry);
      }
    };
    // Requirements, approval, and PCB catalog are trusted snapshots and legitimately contain prose.
    const proposalBoundary = {
      irSnapshot: binding.irSnapshot,
      proposalResolutionSnapshot: binding.proposalResolutionSnapshot,
      compilation: binding.compilation
    };
    visit(proposalBoundary);
    expect(canonicalJson(proposalBoundary)).not.toContain("do what this says");
  });

  it("keeps public schema names on the requested first-version contract", () => {
    expect(SYSTEM_ARCHITECTURE_IR_SCHEMA).toBe("evleda.system-architecture-ir.v1");
    expect(PCB_ENGINEERING_PRACTICE_SCHEMA).toBe("evleda.pcb-engineering-practices.v1");
  });
});

import type {
  ApprovalRecord,
  CanonicalIdentity,
  ContentIdentity,
  Requirement,
  RequirementsDocument
} from "../domain/types.js";
import type { PcbEngineeringPracticeCatalog } from "../knowledge/pcb-engineering-practices.js";

const frozen = <Value extends readonly unknown[]>(value: Value): Value => Object.freeze(value);

export const SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA =
  "evleda.system-architecture-option-catalog.v1" as const;
export const SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA =
  "evleda.system-architecture-topology-catalog.v1" as const;
export const SYSTEM_ARCHITECTURE_IR_SCHEMA = "evleda.system-architecture-ir.v1" as const;
export const SYSTEM_ARCHITECTURE_GRAPH_SCHEMA =
  "evleda.system-architecture-graph.v1" as const;
export const SYSTEM_ARCHITECTURE_PROPOSAL_RESOLUTION_SCHEMA =
  "evleda.system-architecture-proposal-resolution.v1" as const;
export const SYSTEM_ARCHITECTURE_DECISION_BINDING_SCHEMA =
  "evleda.system-architecture-decision-binding.v1" as const;
export const SYSTEM_ARCHITECTURE_DECISION_COMPILATION_SCHEMA =
  "evleda.system-architecture-decision-compilation.v1" as const;
export const SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA =
  "evleda.system-architecture-decision-registry.v1" as const;
export const SYSTEM_ARCHITECTURE_APPROVAL_IDENTITY_SCHEMA =
  "evleda.requirements-approval-record.v1" as const;

export const SYSTEM_ARCHITECTURE_NODE_KINDS = frozen([
  "power_source",
  "power_conversion",
  "power_distribution",
  "protection",
  "controller",
  "actuator_driver",
  "sensor_interface",
  "communications",
  "clock",
  "memory",
  "debug",
  "connector"
] as const);
export type SystemArchitectureNodeKind = (typeof SYSTEM_ARCHITECTURE_NODE_KINDS)[number];

export const SYSTEM_ARCHITECTURE_PORT_DIRECTIONS = frozen([
  "input",
  "output",
  "bidirectional"
] as const);
export type SystemArchitecturePortDirection =
  (typeof SYSTEM_ARCHITECTURE_PORT_DIRECTIONS)[number];

export const SYSTEM_ARCHITECTURE_PORT_TYPES = frozen([
  "power_dc",
  "power_return",
  "analog",
  "digital_single_ended",
  "digital_differential",
  "clock",
  "reset",
  "fault",
  "control",
  "debug"
] as const);
export type SystemArchitecturePortType = (typeof SYSTEM_ARCHITECTURE_PORT_TYPES)[number];

export const SYSTEM_ARCHITECTURE_PROTOCOLS = frozen([
  "none",
  "gpio",
  "pwm",
  "uart",
  "i2c",
  "spi",
  "can",
  "usb2",
  "swd",
  "quadrature"
] as const);
export type SystemArchitectureProtocol = (typeof SYSTEM_ARCHITECTURE_PROTOCOLS)[number];

export const SYSTEM_ARCHITECTURE_SAFE_STATE_TRIGGERS = frozen([
  "reset",
  "power_loss",
  "fault",
  "watchdog",
  "uncommanded"
] as const);
export type SystemArchitectureSafeStateTrigger =
  (typeof SYSTEM_ARCHITECTURE_SAFE_STATE_TRIGGERS)[number];

export const SYSTEM_ARCHITECTURE_SAFE_STATE_ACTIONS = frozen([
  "drive_low",
  "drive_high",
  "high_impedance",
  "disable",
  "hold_reset"
] as const);
export type SystemArchitectureSafeStateAction =
  (typeof SYSTEM_ARCHITECTURE_SAFE_STATE_ACTIONS)[number];

export const SYSTEM_ARCHITECTURE_SAFE_STATE_MECHANISMS = frozen([
  "hardware_bias",
  "hardware_latch",
  "power_domain_default",
  "firmware_guard"
] as const);
export type SystemArchitectureSafeStateMechanism =
  (typeof SYSTEM_ARCHITECTURE_SAFE_STATE_MECHANISMS)[number];

export const SYSTEM_ARCHITECTURE_SAFE_STATE_RELEASE_CONDITIONS = frozen([
  "none",
  "manual_reset",
  "validated_command",
  "power_cycle"
] as const);
export type SystemArchitectureSafeStateReleaseCondition =
  (typeof SYSTEM_ARCHITECTURE_SAFE_STATE_RELEASE_CONDITIONS)[number];

export const SYSTEM_ARCHITECTURE_PATH_KINDS = frozen([
  "power_delivery",
  "current_return",
  "signal",
  "control",
  "protection",
  "fault_propagation",
  "reset",
  "clock",
  "communication",
  "high_di_dt_loop"
] as const);
export type SystemArchitecturePathKind = (typeof SYSTEM_ARCHITECTURE_PATH_KINDS)[number];

export const SYSTEM_ARCHITECTURE_PARAMETER_UNITS = frozen([
  "count",
  "millivolt",
  "milliampere",
  "milliwatt",
  "hertz",
  "nanosecond",
  "micrometre",
  "degree_celsius"
] as const);
export type SystemArchitectureParameterUnit =
  (typeof SYSTEM_ARCHITECTURE_PARAMETER_UNITS)[number];

export const SYSTEM_ARCHITECTURE_ALLOCATION_TARGET_KINDS = frozen([
  "node",
  "port",
  "connection",
  "parameter",
  "safe_state",
  "path"
] as const);
export type SystemArchitectureAllocationTargetKind =
  (typeof SYSTEM_ARCHITECTURE_ALLOCATION_TARGET_KINDS)[number];

export const SYSTEM_ARCHITECTURE_DECISION_OPERATIONS = frozen([
  "select_topology",
  "select_option",
  "instantiate_node",
  "declare_port",
  "connect_ports",
  "allocate_requirement",
  "bind_parameter",
  "declare_safe_state",
  "declare_path",
  "allocate_practice"
] as const);
export type SystemArchitectureDecisionOperation =
  (typeof SYSTEM_ARCHITECTURE_DECISION_OPERATIONS)[number];

export const SYSTEM_ARCHITECTURE_MANDATORY_VALIDATOR_IDS = frozen([
  "evleda.system-architecture.topology-validator.v1",
  "evleda.system-architecture.requirement-allocation-validator.v1",
  "evleda.system-architecture.path-coverage-validator.v1",
  "evleda.system-architecture.safe-state-validator.v1",
  "evleda.system-architecture.pcb-practice-allocation-validator.v1"
] as const);
export type SystemArchitectureMandatoryValidatorId =
  (typeof SYSTEM_ARCHITECTURE_MANDATORY_VALIDATOR_IDS)[number];

export type SystemArchitectureRequirementCategory = Requirement["category"];
export type SystemArchitectureRequirementPriority = Requirement["priority"];

export interface SystemArchitectureSafeStateTuple {
  readonly trigger: SystemArchitectureSafeStateTrigger;
  readonly action: SystemArchitectureSafeStateAction;
  readonly mechanism: SystemArchitectureSafeStateMechanism;
  readonly releaseCondition: SystemArchitectureSafeStateReleaseCondition;
}

export interface SystemArchitecturePortTemplate {
  readonly key: string;
  readonly direction: SystemArchitecturePortDirection;
  readonly type: SystemArchitecturePortType;
  readonly protocol: SystemArchitectureProtocol;
  readonly minimumConnections: number;
  readonly maximumConnections: number;
  readonly compatibilityParameterKeys: readonly string[];
  /** Exact reviewed tuples. Input-port hardware bias is intentionally expressible. */
  readonly allowedSafeStateTuples: readonly SystemArchitectureSafeStateTuple[];
}

export interface SystemArchitectureParameterDomain {
  readonly key: string;
  readonly targetKind: "node" | "port";
  readonly targetTemplateKey: string | null;
  readonly unit: SystemArchitectureParameterUnit;
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
  readonly required: boolean;
  /** Reviewed source selectors prevent same-unit requirement/constraint rebinding. */
  readonly allowedRequirementSources: readonly {
    readonly normalizedConstraintKey: string;
    readonly category: SystemArchitectureRequirementCategory;
    readonly priority: SystemArchitectureRequirementPriority;
  }[];
}

export interface SystemArchitectureOptionPracticeRequirement {
  readonly practiceId: string;
  readonly scope: "per_node";
  readonly allowedTargetKinds: readonly SystemArchitectureAllocationTargetKind[];
  readonly allowedPathKinds: readonly SystemArchitecturePathKind[];
}

export interface SystemArchitectureOption {
  readonly id: string;
  readonly nodeKind: SystemArchitectureNodeKind;
  readonly portTemplates: readonly SystemArchitecturePortTemplate[];
  readonly parameterDomains: readonly SystemArchitectureParameterDomain[];
  readonly requiredPractices: readonly SystemArchitectureOptionPracticeRequirement[];
}

export interface SystemArchitectureOptionCatalogPayload {
  readonly schemaVersion: typeof SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA;
  readonly options: readonly SystemArchitectureOption[];
}

export interface SystemArchitectureOptionCatalog
  extends SystemArchitectureOptionCatalogPayload {
  readonly identity: CanonicalIdentity;
}

export interface SystemArchitectureTopologyRoleTemplate {
  readonly id: string;
  readonly allowedOptionIds: readonly string[];
  readonly minimumInstances: number;
  readonly maximumInstances: number;
}

export interface SystemArchitectureTopologyEdgeTemplate {
  readonly id: string;
  readonly driverRoleId: string;
  readonly driverPortTemplateKey: string;
  readonly receiverRoleId: string;
  readonly receiverPortTemplateKey: string;
  readonly type: SystemArchitecturePortType;
  readonly protocol: SystemArchitectureProtocol;
  readonly minimumConnections: number;
  readonly maximumConnections: number;
  readonly maximumFanoutPerDriverPort: number;
  readonly maximumFaninPerReceiverPort: number;
  readonly requiredPathPolicyIds: readonly string[];
}

export interface SystemArchitectureTopologyPathEndpoint {
  readonly roleId: string;
  readonly portTemplateKey: string;
}

export interface SystemArchitectureTopologyPathPolicy {
  readonly id: string;
  readonly kind: SystemArchitecturePathKind;
  readonly type: SystemArchitecturePortType;
  readonly protocol: SystemArchitectureProtocol;
  readonly start: SystemArchitectureTopologyPathEndpoint;
  readonly end: SystemArchitectureTopologyPathEndpoint;
  /** The complete reviewed edge-template sequence for every path instance. */
  readonly orderedEdgeTemplateIds: readonly string[];
  readonly minimumPaths: number;
  readonly maximumPaths: number;
}

export interface SystemArchitectureTopologySafeStatePolicy
  extends SystemArchitectureSafeStateTuple {
  readonly roleId: string;
  readonly portTemplateKey: string;
  readonly required: boolean;
}

export interface SystemArchitectureRequirementAllocationPolicy {
  readonly category: SystemArchitectureRequirementCategory;
  readonly priority: SystemArchitectureRequirementPriority;
  readonly allowedTargetKinds: readonly SystemArchitectureAllocationTargetKind[];
  readonly allowedTopologyRoleIds: readonly string[];
  readonly allowedPathKinds: readonly SystemArchitecturePathKind[];
  readonly minimumAllocations: number;
  readonly maximumAllocations: number;
}

export interface SystemArchitectureTopologyTemplate {
  readonly id: string;
  readonly roles: readonly SystemArchitectureTopologyRoleTemplate[];
  readonly edges: readonly SystemArchitectureTopologyEdgeTemplate[];
  readonly pathPolicies: readonly SystemArchitectureTopologyPathPolicy[];
  readonly safeStatePolicies: readonly SystemArchitectureTopologySafeStatePolicy[];
  readonly requirementAllocationPolicies:
    readonly SystemArchitectureRequirementAllocationPolicy[];
}

export interface SystemArchitectureTopologyCatalogPayload {
  readonly schemaVersion: typeof SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA;
  readonly topologies: readonly SystemArchitectureTopologyTemplate[];
}

export interface SystemArchitectureTopologyCatalog
  extends SystemArchitectureTopologyCatalogPayload {
  readonly identity: CanonicalIdentity;
}

export interface SystemArchitectureDecisionRegistryPayload {
  readonly schemaVersion: typeof SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA;
  readonly enabledOperations: readonly SystemArchitectureDecisionOperation[];
  readonly compiler: {
    readonly compilerId: "evleda.system-architecture.decision-compiler.v1";
    readonly implementationVersion: string;
    readonly implementationContentIdentity: ContentIdentity;
  };
  readonly validators: readonly {
    readonly validatorId: SystemArchitectureMandatoryValidatorId;
    readonly implementationVersion: string;
    readonly implementationContentIdentity: ContentIdentity;
  }[];
}

export interface SystemArchitectureDecisionRegistry
  extends SystemArchitectureDecisionRegistryPayload {
  readonly identity: CanonicalIdentity;
}

export interface SystemArchitectureSelectedOption {
  readonly optionId: string;
}

export interface SystemArchitectureIrNode {
  readonly id: string;
  readonly topologyRoleId: string;
  readonly optionId: string;
  readonly requirementIds: readonly string[];
}

export interface SystemArchitectureIrPort {
  readonly id: string;
  readonly nodeId: string;
  readonly templateKey: string;
  readonly direction: SystemArchitecturePortDirection;
  readonly type: SystemArchitecturePortType;
  readonly protocol: SystemArchitectureProtocol;
  readonly requirementIds: readonly string[];
}

export interface SystemArchitectureIrConnection {
  readonly id: string;
  readonly edgeTemplateId: string;
  readonly type: SystemArchitecturePortType;
  readonly protocol: SystemArchitectureProtocol;
  readonly driverPortId: string;
  readonly receiverPortId: string;
  readonly requirementIds: readonly string[];
}

export interface ApprovedRequirementValueSource {
  readonly valueSource: "approved_requirement";
  readonly requirementId: string;
  /** Resolves the actual v1 requirements.constraints[normalizedConstraintKey] numeric string. */
  readonly normalizedConstraintKey: string;
}

export interface SystemArchitectureIrParameter {
  readonly id: string;
  readonly nodeId: string;
  readonly optionId: string;
  readonly targetKind: "node" | "port";
  readonly targetId: string;
  readonly parameterKey: string;
  readonly requirementIds: readonly string[];
  readonly source: ApprovedRequirementValueSource;
}

export interface SystemArchitectureIrSafeState extends SystemArchitectureSafeStateTuple {
  readonly id: string;
  readonly nodeId: string;
  readonly targetPortId: string;
  readonly requirementIds: readonly string[];
}

export interface SystemArchitectureIrPath {
  readonly id: string;
  readonly pathPolicyId: string;
  readonly kind: SystemArchitecturePathKind;
  readonly type: SystemArchitecturePortType;
  readonly protocol: SystemArchitectureProtocol;
  readonly startPortId: string;
  readonly endPortId: string;
  readonly orderedConnectionIds: readonly string[];
  readonly requirementIds: readonly string[];
}

export interface SystemArchitectureIrAllocation {
  readonly id: string;
  readonly requirementId: string;
  readonly targetKind: SystemArchitectureAllocationTargetKind;
  readonly targetId: string;
}

export interface SystemArchitectureIrPracticeAllocation {
  readonly id: string;
  readonly practiceId: string;
  readonly targetKind: SystemArchitectureAllocationTargetKind;
  readonly targetId: string;
}

export interface SystemArchitectureIrPayload {
  readonly schemaVersion: typeof SYSTEM_ARCHITECTURE_IR_SCHEMA;
  readonly stage: "system_architecture";
  readonly role: "system_architect";
  readonly classification: "proposal_only";
  readonly authorityDisposition: "none";
  readonly topologyTemplateId: string;
  readonly requirementsIdentity: CanonicalIdentity;
  readonly requirementsApprovalIdentity: CanonicalIdentity;
  readonly optionCatalogIdentity: CanonicalIdentity;
  readonly topologyCatalogIdentity: CanonicalIdentity;
  readonly pcbPracticeCatalogIdentity: CanonicalIdentity;
  readonly registryIdentity: CanonicalIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
  readonly selectedOptions: readonly SystemArchitectureSelectedOption[];
  readonly nodes: readonly SystemArchitectureIrNode[];
  readonly ports: readonly SystemArchitectureIrPort[];
  readonly connections: readonly SystemArchitectureIrConnection[];
  readonly allocations: readonly SystemArchitectureIrAllocation[];
  readonly parameters: readonly SystemArchitectureIrParameter[];
  readonly safeStates: readonly SystemArchitectureIrSafeState[];
  readonly paths: readonly SystemArchitectureIrPath[];
  readonly practiceAllocations: readonly SystemArchitectureIrPracticeAllocation[];
}

export interface SystemArchitectureIr extends SystemArchitectureIrPayload {
  readonly identity: CanonicalIdentity;
}

/** Returned only by a constructor-captured authenticated replay/receipt resolver. */
export interface ResolvedSystemArchitectureProposalPayload {
  readonly schemaVersion: typeof SYSTEM_ARCHITECTURE_PROPOSAL_RESOLUTION_SCHEMA;
  readonly receiptId: string;
  readonly replayReceiptIdentity: CanonicalIdentity;
  readonly replayIdentity: CanonicalIdentity;
  readonly proposalResultIdentity: CanonicalIdentity;
  readonly structuredProposalIdentity: CanonicalIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
  readonly irIdentity: CanonicalIdentity;
  readonly irSnapshot: SystemArchitectureIr;
}

export interface ResolvedSystemArchitectureProposal
  extends ResolvedSystemArchitectureProposalPayload {
  readonly identity: CanonicalIdentity;
}

export interface CompiledSystemArchitectureNode extends SystemArchitectureIrNode {
  readonly nodeKind: SystemArchitectureNodeKind;
}

export interface CompiledSystemArchitectureParameter
  extends SystemArchitectureIrParameter {
  readonly value: number;
  readonly unit: SystemArchitectureParameterUnit;
}

export interface SystemArchitectureGraphPayload {
  readonly schemaVersion: typeof SYSTEM_ARCHITECTURE_GRAPH_SCHEMA;
  readonly stage: "system_architecture";
  readonly role: "system_architect";
  readonly classification: "proposal_only";
  readonly lifecycle: "candidate";
  readonly authority: "none";
  readonly receiptId: string;
  readonly proposalResolutionIdentity: CanonicalIdentity;
  readonly replayReceiptIdentity: CanonicalIdentity;
  readonly replayIdentity: CanonicalIdentity;
  readonly proposalResultIdentity: CanonicalIdentity;
  readonly structuredProposalIdentity: CanonicalIdentity;
  readonly requirementsIdentity: CanonicalIdentity;
  readonly requirementsApprovalIdentity: CanonicalIdentity;
  readonly optionCatalogIdentity: CanonicalIdentity;
  readonly topologyCatalogIdentity: CanonicalIdentity;
  readonly pcbPracticeCatalogIdentity: CanonicalIdentity;
  readonly registryIdentity: CanonicalIdentity;
  readonly compilerImplementationContentIdentity: ContentIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
  readonly irIdentity: CanonicalIdentity;
  readonly topologyTemplateId: string;
  readonly selectedOptions: readonly SystemArchitectureSelectedOption[];
  readonly nodes: readonly CompiledSystemArchitectureNode[];
  readonly ports: readonly SystemArchitectureIrPort[];
  readonly connections: readonly SystemArchitectureIrConnection[];
  readonly allocations: readonly SystemArchitectureIrAllocation[];
  readonly parameters: readonly CompiledSystemArchitectureParameter[];
  readonly safeStates: readonly SystemArchitectureIrSafeState[];
  readonly paths: readonly SystemArchitectureIrPath[];
  readonly practiceAllocations: readonly SystemArchitectureIrPracticeAllocation[];
}

export interface SystemArchitectureGraph extends SystemArchitectureGraphPayload {
  readonly identity: CanonicalIdentity;
}

export const SYSTEM_ARCHITECTURE_DECISION_ISSUE_CODES = frozen([
  "INPUT_IDENTITY_MISMATCH",
  "REQUIREMENT_REFERENCE_MISSING",
  "REQUIREMENT_UNALLOCATED",
  "REQUIREMENT_ALLOCATION_POLICY_MISSING",
  "REQUIREMENT_ALLOCATION_TARGET_FORBIDDEN",
  "REQUIREMENT_ALLOCATION_CARDINALITY_INVALID",
  "REQUIREMENT_PROPAGATION_MISMATCH",
  "TOPOLOGY_TEMPLATE_MISSING",
  "TOPOLOGY_ROLE_MISSING",
  "TOPOLOGY_ROLE_OPTION_FORBIDDEN",
  "TOPOLOGY_ROLE_CARDINALITY_INVALID",
  "CATALOG_OPTION_MISSING",
  "OPTION_NOT_SELECTED",
  "OPTION_UNUSED",
  "PORT_TEMPLATE_MISSING",
  "PORT_TEMPLATE_DUPLICATE",
  "PORT_DIRECTION_MISMATCH",
  "PORT_TYPE_MISMATCH",
  "PORT_PROTOCOL_MISMATCH",
  "PORT_CARDINALITY_INVALID",
  "CONNECTION_ENDPOINT_MISSING",
  "CONNECTION_EDGE_TEMPLATE_MISSING",
  "CONNECTION_EDGE_FORBIDDEN",
  "CONNECTION_TYPE_MISMATCH",
  "CONNECTION_PROTOCOL_MISMATCH",
  "CONNECTION_DUPLICATE_ENDPOINT",
  "CONNECTION_EDGE_CARDINALITY_INVALID",
  "CONNECTION_FANOUT_INVALID",
  "CONNECTION_FANIN_INVALID",
  "CONNECTION_PATH_COVERAGE_MISSING",
  "ALLOCATION_TARGET_MISSING",
  "ALLOCATION_DUPLICATE",
  "ALLOCATION_REQUIREMENT_MISMATCH",
  "PARAMETER_DOMAIN_MISSING",
  "PARAMETER_TARGET_MISMATCH",
  "PARAMETER_REQUIRED_BINDING_MISSING",
  "PARAMETER_DUPLICATE_BINDING",
  "PARAMETER_SOURCE_REQUIREMENT_MISMATCH",
  "PARAMETER_CONSTRAINT_MISSING",
  "PARAMETER_CONSTRAINT_OWNER_MISMATCH",
  "PARAMETER_DOMAIN_MISMATCH",
  "PRACTICE_REFERENCE_MISSING",
  "PRACTICE_ALLOCATION_DUPLICATE",
  "PRACTICE_ALLOCATION_TARGET_FORBIDDEN",
  "PRACTICE_UNALLOCATED",
  "SAFE_STATE_TARGET_MISSING",
  "SAFE_STATE_NODE_MISMATCH",
  "SAFE_STATE_TUPLE_NOT_ALLOWED",
  "SAFE_STATE_TOPOLOGY_POLICY_MISSING",
  "SAFE_STATE_DUPLICATE",
  "REGISTRY_OPERATION_DISABLED",
  "GLOBAL_ID_DUPLICATE",
  "PATH_POLICY_MISSING",
  "PATH_CONNECTION_MISSING",
  "PATH_EDGE_SEQUENCE_MISMATCH",
  "PATH_KIND_MISMATCH",
  "PATH_TYPE_MISMATCH",
  "PATH_PROTOCOL_MISMATCH",
  "PATH_ENDPOINT_MISMATCH",
  "PATH_INTERNAL_HOP_MISMATCH",
  "PATH_LOOP_NOT_CLOSED",
  "PATH_CARDINALITY_INVALID",
  "PORT_COMPATIBILITY_PARAMETER_MISSING",
  "PORT_COMPATIBILITY_PARAMETER_MISMATCH",
  "SEMANTIC_OPERATION_BUDGET_EXCEEDED"
] as const);
export type SystemArchitectureDecisionIssueCode =
  (typeof SYSTEM_ARCHITECTURE_DECISION_ISSUE_CODES)[number];

export interface SystemArchitectureDecisionIssue {
  readonly code: SystemArchitectureDecisionIssueCode;
  readonly entityId: string | null;
  readonly requirementIds: readonly string[];
}

export interface SystemArchitectureDecisionCompilationPayload {
  readonly schemaVersion: typeof SYSTEM_ARCHITECTURE_DECISION_COMPILATION_SCHEMA;
  readonly classification: "proposal_only";
  readonly lifecycle: "candidate";
  readonly authority: "none";
  readonly disposition: "accepted" | "rejected";
  readonly receiptId: string;
  readonly proposalResolutionIdentity: CanonicalIdentity;
  readonly replayReceiptIdentity: CanonicalIdentity;
  readonly replayIdentity: CanonicalIdentity;
  readonly proposalResultIdentity: CanonicalIdentity;
  readonly structuredProposalIdentity: CanonicalIdentity;
  readonly requirementsIdentity: CanonicalIdentity;
  readonly requirementsApprovalIdentity: CanonicalIdentity;
  readonly optionCatalogIdentity: CanonicalIdentity;
  readonly topologyCatalogIdentity: CanonicalIdentity;
  readonly pcbPracticeCatalogIdentity: CanonicalIdentity;
  readonly registryIdentity: CanonicalIdentity;
  readonly compilerImplementationContentIdentity: ContentIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
  readonly irIdentity: CanonicalIdentity;
  readonly issues: readonly SystemArchitectureDecisionIssue[];
  readonly graph: SystemArchitectureGraph | null;
  readonly graphIdentity: CanonicalIdentity | null;
}

export interface SystemArchitectureDecisionCompilation
  extends SystemArchitectureDecisionCompilationPayload {
  readonly identity: CanonicalIdentity;
}

export interface SystemArchitectureDecisionBindingPayload {
  readonly schemaVersion: typeof SYSTEM_ARCHITECTURE_DECISION_BINDING_SCHEMA;
  readonly requirementsSnapshot: RequirementsDocument;
  readonly requirementsIdentity: CanonicalIdentity;
  readonly requirementsApprovalSnapshot: ApprovalRecord;
  readonly requirementsApprovalIdentity: CanonicalIdentity;
  readonly optionCatalogSnapshot: SystemArchitectureOptionCatalog;
  readonly optionCatalogIdentity: CanonicalIdentity;
  readonly topologyCatalogSnapshot: SystemArchitectureTopologyCatalog;
  readonly topologyCatalogIdentity: CanonicalIdentity;
  readonly pcbPracticeCatalogSnapshot: PcbEngineeringPracticeCatalog;
  readonly pcbPracticeCatalogIdentity: CanonicalIdentity;
  readonly registrySnapshot: SystemArchitectureDecisionRegistry;
  readonly registryIdentity: CanonicalIdentity;
  readonly compilerImplementationContentIdentity: ContentIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
  readonly proposalResolutionSnapshot: ResolvedSystemArchitectureProposal;
  readonly proposalResolutionIdentity: CanonicalIdentity;
  readonly irSnapshot: SystemArchitectureIr;
  readonly irIdentity: CanonicalIdentity;
  readonly compilation: SystemArchitectureDecisionCompilation;
  readonly compilationIdentity: CanonicalIdentity;
}

export interface SystemArchitectureDecisionBinding
  extends SystemArchitectureDecisionBindingPayload {
  readonly identity: CanonicalIdentity;
}

/** The invocation contains no caller-supplied trust roots, IR, or identities. */
export interface SystemArchitectureDecisionRequest {
  readonly receiptId: unknown;
}

export interface SystemArchitectureDecisionExpectedIdentities {
  readonly requirementsIdentity: CanonicalIdentity;
  readonly requirementsApprovalIdentity: CanonicalIdentity;
  readonly optionCatalogIdentity: CanonicalIdentity;
  readonly topologyCatalogIdentity: CanonicalIdentity;
  readonly pcbPracticeCatalogIdentity: CanonicalIdentity;
  readonly registryIdentity: CanonicalIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
}

/**
 * Host-composition input. The two closures are authority capabilities captured once; they are
 * deliberately absent from per-run requests and from emitted bindings.
 */
export interface SystemArchitectureDecisionCompilerProvision {
  readonly requirementsDocument: unknown;
  readonly requirementsApproval: unknown;
  readonly optionCatalog: unknown;
  readonly topologyCatalog: unknown;
  readonly pcbPracticeCatalog: unknown;
  readonly registry: unknown;
  readonly expectedIdentities: unknown;
  readonly verificationTime: unknown;
  readonly authenticateRequirementsApproval: (
    approval: ApprovalRecord,
    requirements: RequirementsDocument
  ) => void;
  readonly resolveAuthenticatedProposal: (receiptId: string) => Promise<unknown>;
}

export interface SystemArchitectureDecisionCompiler {
  compile(request: SystemArchitectureDecisionRequest): Promise<SystemArchitectureDecisionCompilation>;
  compileBinding(request: SystemArchitectureDecisionRequest): Promise<SystemArchitectureDecisionBinding>;
  validateCompilation(
    value: unknown,
    request: SystemArchitectureDecisionRequest
  ): Promise<SystemArchitectureDecisionCompilation>;
  /** Uses this compiler instance's captured provision and receipt resolver. */
  validateBinding(value: unknown): Promise<SystemArchitectureDecisionBinding>;
  readonly pinnedIdentities: SystemArchitectureDecisionExpectedIdentities;
}

export const SYSTEM_ARCHITECTURE_DECISION_LIMITS = Object.freeze({
  options: 128,
  topologies: 64,
  rolesPerTopology: 128,
  edgesPerTopology: 512,
  pathPoliciesPerTopology: 512,
  safeStatePoliciesPerTopology: 2_048,
  allocationPoliciesPerTopology: 30,
  portTemplatesPerOption: 64,
  parameterDomainsPerOption: 64,
  practicesPerOption: 64,
  requirements: 512,
  operations: SYSTEM_ARCHITECTURE_DECISION_OPERATIONS.length,
  selectedOptions: 128,
  nodes: 128,
  ports: 1_024,
  connections: 1_024,
  allocations: 4_096,
  parameters: 4_096,
  safeStates: 2_048,
  paths: 1_024,
  practiceAllocations: 4_096,
  referencesPerRecord: 256,
  graphDepth: 48,
  graphContainers: 100_000,
  graphPrimitives: 500_000,
  graphOwnProperties: 500_000,
  propertiesPerObject: 8_192,
  propertyKeyBytes: 512,
  stringValueBytes: 65_536,
  totalUtf8Bytes: 16 * 1024 * 1024,
  artifactGraphContainers: 800_000,
  artifactGraphPrimitives: 4_000_000,
  artifactGraphOwnProperties: 4_000_000,
  artifactTotalUtf8Bytes: 128 * 1024 * 1024,
  implementationBytes: 64 * 1024 * 1024,
  semanticOperations: 5_000_000,
  issues: 16_384
} as const);

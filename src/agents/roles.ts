import type { StageKey } from "../domain/stages.js";

const deepFreeze = <Value>(value: Value, seen = new Set<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
};

export const DESIGN_AGENT_ROLES = deepFreeze([
  "requirements_analyst",
  "system_architect",
  "component_engineer",
  "schematic_engineer",
  "firmware_contract_engineer",
  "simulation_engineer",
  "pcb_layout_engineer",
  "manufacturing_engineer",
  "bringup_engineer"
] as const);

export type DesignAgentRole = (typeof DESIGN_AGENT_ROLES)[number];

export const DESIGN_AGENT_ROLE_BY_STAGE = deepFreeze({
  requirements: "requirements_analyst",
  system_architecture: "system_architect",
  component_selection: "component_engineer",
  schematic: "schematic_engineer",
  firmware_contract: "firmware_contract_engineer",
  simulation_checks: "simulation_engineer",
  pcb_placement_routing: "pcb_layout_engineer",
  manufacturing_package: "manufacturing_engineer",
  bringup_package: "bringup_engineer"
} as const satisfies Readonly<Record<StageKey, DesignAgentRole>>);

export const DESIGN_AGENT_ROLE_OBJECTIVES = deepFreeze({
  requirements_analyst:
    "Extract source-linked electrical, mechanical, environmental, fabrication, and verification requirements; expose ambiguity and never invent a value needed for topology, protection, sizing, or layout.",
  system_architect:
    "Propose power, signal, control, protection, fault, current-path, return-path, hot-loop, and interface architecture with explicit requirement and engineering-practice allocation.",
  component_engineer:
    "Propose exact orderable components and alternates only with source-bound electrical, thermal, package, lifecycle, sourcing, footprint, pin-pad, reference-circuit, and layout obligations.",
  schematic_engineer:
    "Propose an editable schematic intent and exact connectivity contract, including safe states, protection chains, decoupling, current paths, pair sections, hot-loop endpoints, and layout-critical net roles.",
  firmware_contract_engineer:
    "Propose pin, resource, peripheral, voltage-domain, reset, fault, boot, revision, and protocol contracts that deterministic checks can compare with native schematic connectivity.",
  simulation_engineer:
    "Propose source-bound calculations and simulation coverage, state every model assumption and unsupported gap, and request deterministic or physical validation without claiming a pass.",
  pcb_layout_engineer:
    "Propose placement and routing that follows the bound rule set: electrically derived widths, straight or profile-approved bend geometry, valid vias, continuous returns, compact hot loops, controlled differential pairs, and explicit DFM constraints.",
  manufacturing_engineer:
    "Propose a complete candidate fabrication and assembly package, distinguish published capability from written fabricator approval, and preserve every unresolved DFM, impedance, stackup, substitution, and process gate.",
  bringup_engineer:
    "Propose guarded inspection, power-up, programming, communications, load, thermal, fault, and acceptance procedures with equipment, limits, abort conditions, raw records, and no fabricated physical results."
} as const satisfies Readonly<Record<DesignAgentRole, string>>);

export const DESIGN_AGENT_PROPOSAL_KINDS_BY_ROLE = deepFreeze({
  requirements_analyst: ["requirement", "research", "clarification"],
  system_architect: ["architecture", "research", "clarification"],
  component_engineer: ["component", "research", "clarification"],
  schematic_engineer: ["schematic", "research", "clarification"],
  firmware_contract_engineer: ["firmware_contract", "clarification"],
  simulation_engineer: ["simulation", "research", "clarification"],
  pcb_layout_engineer: ["placement", "routing", "research", "clarification"],
  manufacturing_engineer: ["manufacturing", "research", "clarification"],
  bringup_engineer: ["bringup", "clarification"]
} as const);

export const DESIGN_AGENT_VALIDATOR_IDS_BY_ROLE = deepFreeze({
  requirements_analyst: ["evleda.requirements-validator.v1"],
  system_architect: ["evleda.system-architecture-validator.v1"],
  component_engineer: ["evleda.component-selection-validator.v1"],
  schematic_engineer: ["evleda.schematic-contract-validator.v1", "kicad.erc.v1"],
  firmware_contract_engineer: ["evleda.firmware-parity-validator.v1"],
  simulation_engineer: ["evleda.simulation-report-validator.v1"],
  pcb_layout_engineer: ["evleda.pcb-practice-analyzer.v1", "kicad.drc.v1"],
  manufacturing_engineer: ["evleda.manufacturing-package-validator.v1"],
  bringup_engineer: ["evleda.bringup-plan-validator.v1"]
} as const);

export const roleForStage = (stage: StageKey): DesignAgentRole =>
  DESIGN_AGENT_ROLE_BY_STAGE[stage];

export const roleMatchesStage = (stage: StageKey, role: DesignAgentRole): boolean =>
  DESIGN_AGENT_ROLE_BY_STAGE[stage] === role;

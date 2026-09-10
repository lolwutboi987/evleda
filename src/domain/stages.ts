export const STAGE_ORDER = [
  "requirements",
  "system_architecture",
  "component_selection",
  "schematic",
  "firmware_contract",
  "simulation_checks",
  "pcb_placement_routing",
  "manufacturing_package",
  "bringup_package"
] as const;

export type StageKey = (typeof STAGE_ORDER)[number];

export const downstreamStages = (stage: StageKey): readonly StageKey[] => {
  const index = STAGE_ORDER.indexOf(stage);
  return STAGE_ORDER.slice(index + 1);
};

export const stageIndex = (stage: StageKey): number => STAGE_ORDER.indexOf(stage);


import { DomainError } from "../domain/errors.js";
import { STAGE_ORDER, type StageKey } from "../domain/stages.js";
import { bringupPackageStageExecutor } from "../generators/bringup-generator.js";
import { componentSelectionStageExecutor } from "../generators/component-selection-generator.js";
import { firmwareContractStageExecutor } from "../generators/firmware-contract-generator.js";
import { manufacturingPackageStageExecutor } from "../generators/manufacturing-generator.js";
import { pcbPlacementRoutingStageExecutor } from "../generators/pcb-generator.js";
import { requirementsStageExecutor } from "../generators/requirements-generator.js";
import { schematicStageExecutor } from "../generators/schematic-generator.js";
import { simulationChecksStageExecutor } from "../generators/simulation-checks-generator.js";
import { systemArchitectureStageExecutor } from "../generators/system-architecture-generator.js";
import type {
  StageContextByKey,
  StageExecutionResult,
  StageExecutor,
  StageRegistryContract
} from "./contracts.js";

export type AnyStageExecutor = {
  readonly [K in StageKey]: StageExecutor<K>;
}[StageKey];

export class StageRegistry implements StageRegistryContract {
  readonly #executors = new Map<StageKey, AnyStageExecutor>();

  public constructor(executors: readonly AnyStageExecutor[]) {
    for (const executor of executors) {
      if (this.#executors.has(executor.stage)) {
        throw new DomainError(
          "INVALID_ARGUMENT",
          `Duplicate stage executor registered for ${executor.stage}`
        );
      }
      this.#executors.set(executor.stage, executor);
    }
    const missing = STAGE_ORDER.filter((stage) => !this.#executors.has(stage));
    if (missing.length > 0) {
      throw new DomainError("INVALID_ARGUMENT", "Stage registry is incomplete", { missing });
    }
  }

  public orderedStages(): readonly StageKey[] {
    return STAGE_ORDER;
  }

  public has(stage: StageKey): boolean {
    return this.#executors.has(stage);
  }

  public get<K extends StageKey>(stage: K): StageExecutor<K> {
    const executor = this.#executors.get(stage);
    if (executor === undefined) {
      throw new DomainError("NOT_FOUND", `No stage executor is registered for ${stage}`);
    }
    return executor as StageExecutor<K>;
  }

  public execute<K extends StageKey>(
    stage: K,
    context: StageContextByKey[K]
  ): Promise<StageExecutionResult<K>> {
    return this.get(stage).execute(context);
  }
}

export const createDefaultStageRegistry = (): StageRegistry =>
  new StageRegistry([
    requirementsStageExecutor,
    systemArchitectureStageExecutor,
    componentSelectionStageExecutor,
    schematicStageExecutor,
    firmwareContractStageExecutor,
    simulationChecksStageExecutor,
    pcbPlacementRoutingStageExecutor,
    manufacturingPackageStageExecutor,
    bringupPackageStageExecutor
  ]);

/** A deterministic aggregate budget, not a wall-clock timeout or mutation authority. */
export const FRESH_SCHEMATIC_MAX_WORK_UNITS = 20_000_000;
export const FRESH_SCHEMATIC_WORK_KINDS = [
  "input", "transform", "terminal_group", "collision", "partition", "tree", "label", "route", "placement",
] as const;
export type FreshSchematicWorkKind = typeof FRESH_SCHEMATIC_WORK_KINDS[number];

export interface FreshSchematicWorkSnapshot {
  readonly status: "available" | "exhausted";
  readonly maximum: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly counters: Readonly<Record<FreshSchematicWorkKind, number>>;
  readonly exhaustion: null | Readonly<{ kind: FreshSchematicWorkKind; requested: number; remaining: number }>;
}

export type FreshSchematicBoundedResult<Value> =
  | Readonly<{ status: "complete"; value: Value; work: FreshSchematicWorkSnapshot }>
  | Readonly<{ status: "exhausted"; work: FreshSchematicWorkSnapshot }>;

/**
 * Share one instance across nets, labels, collision checks and placement passes.
 * Charges are atomic: a rejected charge consumes nothing, latches exhaustion,
 * and prevents every later charge. There is deliberately no reset/refund API.
 */
export class FreshSchematicWorkBudget {
  readonly #maximum: number;
  #consumed = 0;
  #exhaustion: FreshSchematicWorkSnapshot["exhaustion"] = null;
  readonly #counters = Object.fromEntries(FRESH_SCHEMATIC_WORK_KINDS.map((kind) => [kind, 0])) as Record<FreshSchematicWorkKind, number>;

  public constructor(maximum = FRESH_SCHEMATIC_MAX_WORK_UNITS) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > FRESH_SCHEMATIC_MAX_WORK_UNITS) {
      throw new RangeError(`Schematic work maximum must be an integer from 1 to ${FRESH_SCHEMATIC_MAX_WORK_UNITS}.`);
    }
    this.#maximum = maximum;
  }

  public charge(kind: FreshSchematicWorkKind, units = 1): boolean {
    if (!FRESH_SCHEMATIC_WORK_KINDS.includes(kind) || !Number.isSafeInteger(units) || units < 1) {
      throw new RangeError("Schematic work charges require a known kind and positive safe-integer units.");
    }
    if (this.#exhaustion !== null) return false;
    const remaining = this.#maximum - this.#consumed;
    if (units > remaining) {
      this.#exhaustion = Object.freeze({ kind, requested: units, remaining });
      return false;
    }
    this.#consumed += units;
    this.#counters[kind] += units;
    return true;
  }

  public snapshot(): FreshSchematicWorkSnapshot {
    return Object.freeze({
      status: this.#exhaustion === null ? "available" : "exhausted",
      maximum: this.#maximum,
      consumed: this.#consumed,
      remaining: this.#maximum - this.#consumed,
      counters: Object.freeze({ ...this.#counters }),
      exhaustion: this.#exhaustion,
    });
  }
}

/**
 * Publish a value only if the entire producer finishes without exhaustion.
 * A producer that ignores a failed charge cannot expose its partial value.
 * Exceptions are not converted into success. No callback runs once exhausted.
 * Producers must be synchronous; a promise cannot close an unfinished phase.
 */
export function withFreshSchematicWorkBudget<Value>(
  budget: FreshSchematicWorkBudget,
  produce: (budget: FreshSchematicWorkBudget) => Value,
): FreshSchematicBoundedResult<Value> {
  if (budget.snapshot().status === "exhausted") return Object.freeze({ status: "exhausted", work: budget.snapshot() });
  const value = produce(budget);
  if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
    throw new TypeError("Schematic work producers must finish synchronously, not return a promise or thenable.");
  }
  const work = budget.snapshot();
  return work.status === "exhausted"
    ? Object.freeze({ status: "exhausted", work })
    : Object.freeze({ status: "complete", value, work });
}

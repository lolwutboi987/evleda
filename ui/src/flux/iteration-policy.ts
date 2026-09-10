import type { FluxIterationCapPolicyDto, FluxRuntimePolicyDto } from "./model";

const record = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export const parseFluxIterationCapPolicy = (value: unknown): FluxIterationCapPolicyDto | undefined => {
  const item = record(value);
  if (item === undefined || Object.keys(item).length !== 3 || !["minimum", "maximum", "recommended"].every((key) => Object.hasOwn(item, key))) return undefined;
  const { minimum, maximum, recommended } = item;
  return Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) && Number.isSafeInteger(recommended) && (minimum as number) >= 1 && (maximum as number) >= (minimum as number) && (recommended as number) >= (minimum as number) && (recommended as number) <= (maximum as number)
    ? { minimum: minimum as number, maximum: maximum as number, recommended: recommended as number }
    : undefined;
};

export const iterationCapFromBounds = (bounds: FluxIterationCapPolicyDto | undefined, value: unknown): number => {
  if (bounds === undefined || !Number.isSafeInteger(value) || (value as number) < bounds.minimum || (value as number) > bounds.maximum) throw new Error("The server iteration-cap policy is missing, malformed, or does not authorize the selected value; no create request was sent.");
  return value as number;
};

export const iterationCapFromPolicy = (policy: FluxRuntimePolicyDto, value: unknown): number => iterationCapFromBounds(parseFluxIterationCapPolicy(policy.iterationCap), value);

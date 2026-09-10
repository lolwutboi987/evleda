import { z } from "zod";
import { canonicalIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { FreshSchematicWorkBudget, type FreshSchematicWorkSnapshot } from "./fresh-schematic-work-budget.js";

export const FRESH_SCHEMATIC_TERMINAL_GROUP_SCHEMA_VERSION = "evleda.fresh-schematic-terminal-groups.v1" as const;
export const FRESH_SCHEMATIC_TERMINAL_LIMITS = Object.freeze({
  maxComponents: 64,
  maxPinsPerComponent: 128,
  maxLogicalPins: 8_192,
  maxNets: 128,
  maxEndpointsPerNet: 256,
  // Two four-decimal roundings in the pinned sidecar coordinate helper.
  liveCorroborationMm: 0.000_101,
  distinctTerminalClearanceMm: 0.001,
});

export type FreshSchematicCardinalAngle = 0 | 90 | 180 | 270;
export interface FreshSchematicPoint { readonly xMm: number; readonly yMm: number }
export interface FreshSchematicSourcePin {
  readonly number: string;
  /** Exact library-space coordinate, positive Y upwards. Never proximity-grouped. */
  readonly at: FreshSchematicPoint;
  readonly angleDeg: FreshSchematicCardinalAngle;
}
export interface FreshSchematicSourceComponent {
  readonly reference: string;
  readonly symbolLibId: string;
  readonly unit: number;
  /** Correlation metadata only. This helper cannot authenticate a caller-provided digest. */
  readonly sourceIdentity: ContentIdentity;
  readonly placement: Readonly<{ at: FreshSchematicPoint; rotationDeg: FreshSchematicCardinalAngle }>;
  readonly pins: readonly FreshSchematicSourcePin[];
}
export type FreshSchematicPinAssignment = Readonly<{ kind: "net"; net: string }> | Readonly<{ kind: "no_connect" }>;
export interface FreshSchematicTerminalInput {
  readonly contractIdentity: CanonicalIdentity;
  readonly components: readonly FreshSchematicSourceComponent[];
  readonly assignments: readonly Readonly<{ reference: string; pin: string; assignment: FreshSchematicPinAssignment }>[];
  readonly livePins: readonly Readonly<{ reference: string; pin: string; at: FreshSchematicPoint; angleDeg: FreshSchematicCardinalAngle }>[];
}
export interface FreshSchematicTerminalGroup {
  readonly id: string;
  readonly reference: string;
  readonly symbolLibId: string;
  readonly unit: number;
  readonly sourceIdentity: ContentIdentity;
  readonly assignment: FreshSchematicPinAssignment;
  readonly memberEndpointIds: readonly string[];
  readonly localAnchor: FreshSchematicPoint;
  /** Unsnapped source transform; live rounding must not erase its collisions. */
  readonly sourceTransformedAnchor: FreshSchematicPoint;
  readonly liveAnchor: FreshSchematicPoint;
  readonly angleDeg: FreshSchematicCardinalAngle;
}
export interface FreshSchematicTerminalPartition {
  readonly schemaVersion: typeof FRESH_SCHEMATIC_TERMINAL_GROUP_SCHEMA_VERSION;
  readonly verificationScope: "metadata_consistency_only";
  readonly requiresSourceAdapterVerification: true;
  readonly contractIdentity: CanonicalIdentity;
  readonly inputIdentity: CanonicalIdentity;
  readonly groups: readonly FreshSchematicTerminalGroup[];
  readonly endpointToGroup: readonly Readonly<{ endpointId: string; groupId: string }>[];
  readonly identity: CanonicalIdentity;
}
export type FreshSchematicTerminalIssueCode =
  | "INVALID_INPUT" | "INVENTORY_MISMATCH" | "SOURCE_LIVE_GEOMETRY_MISMATCH"
  | "SOURCE_STACK_CONFLICT" | "COINCIDENT_DISPOSITION_CONFLICT" | "NO_CONNECT_STACK_UNSUPPORTED"
  | "CROSS_COMPONENT_COLLISION" | "NEAR_PIN_COLLISION" | "PRISTINE_PARTITION_MISMATCH";
export interface FreshSchematicTerminalIssue {
  readonly code: FreshSchematicTerminalIssueCode;
  readonly endpointIds: readonly string[];
  readonly message: string;
}
export type FreshSchematicTerminalResult<Value> =
  | Readonly<{ status: "complete"; value: Value; work: FreshSchematicWorkSnapshot }>
  | Readonly<{ status: "invalid" | "unsupported"; issues: readonly FreshSchematicTerminalIssue[]; work: FreshSchematicWorkSnapshot }>
  | Readonly<{ status: "exhausted"; work: FreshSchematicWorkSnapshot }>;

const text = (maximum: number) => z.string().min(1).max(maximum).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const reference = text(32).regex(/^[A-Z][A-Z0-9_-]{0,31}$/u);
const pinNumber = text(32).regex(/^[A-Za-z0-9][A-Za-z0-9.+/_-]{0,31}$/u);
const coordinate = z.number().finite().min(-2_000).max(2_000).refine((value) => !Object.is(value, -0));
const point = z.object({ xMm: coordinate, yMm: coordinate }).strict();
const angle = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).refine((value) => !Object.is(value, -0));
const contentIdentitySchema = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().positive().max(24 * 1024 * 1024) }).strict();
const contractIdentitySchema = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u), schemaVersion: text(128), canonicalizationVersion: z.literal("evleda-c14n-json-v1") }).strict();
const assignmentSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("net"), net: text(64) }).strict(), z.object({ kind: z.literal("no_connect") }).strict()]);
const componentSchema = z.object({
  reference, symbolLibId: text(192).regex(/^[^\s:]+:[^\s:]+$/u), unit: z.number().int().min(1).max(128), sourceIdentity: contentIdentitySchema,
  placement: z.object({ at: point, rotationDeg: angle }).strict(),
  pins: z.array(z.object({ number: pinNumber, at: point, angleDeg: angle }).strict()).min(1).max(128),
}).strict();
const inputSchema = z.object({
  contractIdentity: contractIdentitySchema,
  components: z.array(componentSchema).min(1).max(64),
  assignments: z.array(z.object({ reference, pin: pinNumber, assignment: assignmentSchema }).strict()).min(1).max(8_192),
  livePins: z.array(z.object({ reference, pin: pinNumber, at: point, angleDeg: angle }).strict()).min(1).max(8_192),
}).strict();
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const endpointId = (value: { readonly reference: string; readonly pin: string }): string => `${value.reference}:${value.pin}`;
const exactPoint = (a: FreshSchematicPoint, b: FreshSchematicPoint): boolean => a.xMm === b.xMm && a.yMm === b.yMm;
const freeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const exhausted = (budget: FreshSchematicWorkBudget): FreshSchematicTerminalResult<never> => Object.freeze({ status: "exhausted", work: budget.snapshot() });
const rejected = (budget: FreshSchematicWorkBudget, code: FreshSchematicTerminalIssueCode, endpointIds: readonly string[], message: string): FreshSchematicTerminalResult<never> => freeze({
  status: code === "NO_CONNECT_STACK_UNSUPPORTED" ? "unsupported" as const : "invalid" as const,
  issues: [{ code, endpointIds: [...endpointIds].sort(order), message }], work: budget.snapshot(),
});

/**
 * Pure geometry convention used by the pinned schematic helper: rotate(x,-y,r).
 * This is NOT the PCB footprint transform. Values are not snapped or repaired.
 * Native source/live adapters must corroborate the same convention independently.
 */
export function transformFreshSchematicSourcePin(pin: FreshSchematicSourcePin, placement: FreshSchematicSourceComponent["placement"]): Readonly<{ at: FreshSchematicPoint; angleDeg: FreshSchematicCardinalAngle }> {
  const x = pin.at.xMm;
  const y = pin.at.yMm;
  const [dx, dy] = placement.rotationDeg === 0 ? [x, -y]
    : placement.rotationDeg === 90 ? [y, x]
      : placement.rotationDeg === 180 ? [-x, y] : [-y, -x];
  return freeze({ at: { xMm: placement.at.xMm + dx!, yMm: placement.at.yMm + dy! }, angleDeg: ((pin.angleDeg - placement.rotationDeg + 360) % 360) as FreshSchematicCardinalAngle });
}

/**
 * Build a consistent candidate terminal partition without changing any pin.
 * IMPORTANT: sourceIdentity and contractIdentity are correlation metadata, not
 * proof of extraction or authority. A production adapter still must read/pin
 * actual symbol and schematic bytes, extract complete local metadata, validate
 * the contract, and obtain exact live placement/pin evidence. No caller hash
 * can upgrade this result from metadata_consistency_only into native evidence.
 */
export function buildSchematicTerminalGroups(input: FreshSchematicTerminalInput, budget = new FreshSchematicWorkBudget()): FreshSchematicTerminalResult<FreshSchematicTerminalPartition> {
  if (budget.snapshot().status === "exhausted") return exhausted(budget);
  // Bound collection traversal before schema parsing. This is a host helper,
  // not the untrusted JSON ingestion boundary; the adapter owns detachment.
  if (!input || !Array.isArray(input.components) || !Array.isArray(input.assignments) || !Array.isArray(input.livePins)
      || input.components.length > 64 || input.assignments.length > 8_192 || input.livePins.length > 8_192
      || input.components.some((component) => !component || !Array.isArray(component.pins) || component.pins.length > 128)) {
    return rejected(budget, "INVALID_INPUT", [], "Terminal metadata exceeds its bounded collection envelope.");
  }
  const sourcePinCount = input.components.reduce((sum, component) => sum + component.pins.length, 0);
  if (sourcePinCount > 8_192) return rejected(budget, "INVALID_INPUT", [], "Terminal metadata exceeds the complete logical-pin bound.");
  if (!budget.charge("input", 1 + input.components.length + sourcePinCount + input.assignments.length + input.livePins.length)) return exhausted(budget);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return rejected(budget, "INVALID_INPUT", [], "Terminal metadata has missing, malformed, nonfinite, or unsupported fields.");
  const data = parsed.data;
  data.components.sort((a, b) => order(a.reference, b.reference));
  for (const component of data.components) component.pins.sort((a, b) => order(a.number, b.number));
  data.assignments.sort((a, b) => order(endpointId(a), endpointId(b)));
  data.livePins.sort((a, b) => order(endpointId(a), endpointId(b)));
  const components = new Map(data.components.map((component) => [component.reference, component]));
  const assignments = new Map(data.assignments.map((assignment) => [endpointId(assignment), assignment.assignment]));
  const live = new Map(data.livePins.map((pin) => [endpointId(pin), pin]));
  const source = new Map(data.components.flatMap((component) => component.pins.map((pin) => [`${component.reference}:${pin.number}`, { component, pin }] as const)));
  if (components.size !== data.components.length || assignments.size !== data.assignments.length || live.size !== data.livePins.length || source.size !== sourcePinCount
      || source.size !== assignments.size || source.size !== live.size || [...source.keys()].some((id) => !assignments.has(id) || !live.has(id))) {
    return rejected(budget, "INVENTORY_MISMATCH", [], "Source, contract assignments, and live metadata must contain every original pin exactly once, with no extras.");
  }
  const netCounts = new Map<string, number>();
  for (const assignment of assignments.values()) if (assignment.kind === "net") {
    const count = (netCounts.get(assignment.net) ?? 0) + 1;
    netCounts.set(assignment.net, count);
    if (count > 256 || netCounts.size > 128) return rejected(budget, "INVALID_INPUT", [], "Net inventory exceeds the existing contract's 128-net/256-endpoint-per-net envelope.");
  }
  const byAnchor = new Map<string, { component: typeof data.components[number]; pins: FreshSchematicSourcePin[] }>();
  const transformedPins = new Map<string, ReturnType<typeof transformFreshSchematicSourcePin>>();
  for (const [id, { component, pin }] of source) {
    if (!budget.charge("transform")) return exhausted(budget);
    const expected = transformFreshSchematicSourcePin(pin, component.placement);
    const observed = live.get(id)!;
    if (Math.abs(observed.at.xMm - expected.at.xMm) > FRESH_SCHEMATIC_TERMINAL_LIMITS.liveCorroborationMm
        || Math.abs(observed.at.yMm - expected.at.yMm) > FRESH_SCHEMATIC_TERMINAL_LIMITS.liveCorroborationMm || observed.angleDeg !== expected.angleDeg) {
      return rejected(budget, "SOURCE_LIVE_GEOMETRY_MISMATCH", [id], "Live pin geometry does not corroborate the source pin and declared cardinal placement.");
    }
    transformedPins.set(id, expected);
    const key = JSON.stringify([component.reference, component.unit, pin.at.xMm, pin.at.yMm]);
    const group = byAnchor.get(key) ?? { component, pins: [] };
    group.pins.push(pin);
    byAnchor.set(key, group);
  }
  const groups: FreshSchematicTerminalGroup[] = [];
  for (const [, candidate] of [...byAnchor].sort(([a], [b]) => order(a, b))) {
    if (!budget.charge("terminal_group", candidate.pins.length)) return exhausted(budget);
    const { component } = candidate;
    const members = candidate.pins.map((pin) => `${component.reference}:${pin.number}`).sort(order);
    const first = members[0]!;
    const assignment = assignments.get(first)!;
    const anchor = live.get(first)!;
    if (candidate.pins.some((pin) => pin.angleDeg !== candidate.pins[0]!.angleDeg)
        || members.some((id) => !exactPoint(live.get(id)!.at, anchor.at) || live.get(id)!.angleDeg !== anchor.angleDeg)) {
      return rejected(budget, "SOURCE_STACK_CONFLICT", members, "A source stack must have one exact local angle and one corroborating live anchor; nearby points are not merged.");
    }
    if (members.some((id) => JSON.stringify(assignments.get(id)) !== JSON.stringify(assignment))) {
      return rejected(budget, "COINCIDENT_DISPOSITION_CONFLICT", members, "Coincident source pins require one identical net assignment; mixed nets or net/no-connect dispositions would conflict.");
    }
    if (members.length > 1 && assignment.kind === "no_connect") {
      return rejected(budget, "NO_CONNECT_STACK_UNSUPPORTED", members, "Stacked no-connect marker semantics require separate native verification; no markers or pins are coalesced here.");
    }
    groups.push({ id: first, reference: component.reference, symbolLibId: component.symbolLibId, unit: component.unit,
      sourceIdentity: component.sourceIdentity, assignment, memberEndpointIds: members, localAnchor: candidate.pins[0]!.at,
      sourceTransformedAnchor: transformedPins.get(first)!.at, liveAnchor: anchor.at, angleDeg: anchor.angleDeg });
  }
  groups.sort((a, b) => order(a.id, b.id));
  // Only distinct groups enter this collision index. Large legitimate stacks
  // do not create a quadratic all-member collision loop.
  const clearance = FRESH_SCHEMATIC_TERMINAL_LIMITS.distinctTerminalClearanceMm;
  // Validate the two evidence domains separately. Corroboration tolerance is
  // not permission to move source anchors apart, nor to ignore live overlap.
  for (const anchorKind of ["sourceTransformedAnchor", "liveAnchor"] as const) {
    const buckets = new Map<string, FreshSchematicTerminalGroup[]>();
    for (const group of groups) {
      const point = group[anchorKind];
      const bx = Math.floor(point.xMm / (2 * clearance));
      const by = Math.floor(point.yMm / (2 * clearance));
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
        if (!budget.charge("collision")) return exhausted(budget);
        for (const prior of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
          if (!budget.charge("collision")) return exhausted(budget);
          const other = prior[anchorKind];
          const floatingNoise = 8 * Number.EPSILON * Math.max(1, Math.abs(point.xMm), Math.abs(point.yMm), Math.abs(other.xMm), Math.abs(other.yMm));
          if (Math.hypot(point.xMm - other.xMm, point.yMm - other.yMm) <= clearance + floatingNoise) {
            return rejected(budget, group.reference === prior.reference ? "NEAR_PIN_COLLISION" : "CROSS_COMPONENT_COLLISION", [...prior.memberEndpointIds, ...group.memberEndpointIds], `Distinct terminals overlap or are too close in ${anchorKind}; a shared net name cannot authorize merging them.`);
          }
        }
      }
      const key = `${bx},${by}`;
      const entries = buckets.get(key) ?? [];
      entries.push(group);
      buckets.set(key, entries);
    }
  }
  const payload = {
    schemaVersion: FRESH_SCHEMATIC_TERMINAL_GROUP_SCHEMA_VERSION,
    verificationScope: "metadata_consistency_only" as const,
    requiresSourceAdapterVerification: true as const,
    contractIdentity: data.contractIdentity,
    inputIdentity: canonicalIdentity(data, "evleda.fresh-schematic-terminal-input.v1"),
    groups,
    endpointToGroup: groups.flatMap((group) => group.memberEndpointIds.map((id) => ({ endpointId: id, groupId: group.id }))).sort((a, b) => order(a.endpointId, b.endpointId)),
  };
  return freeze({ status: "complete", value: { ...payload, identity: canonicalIdentity(payload, FRESH_SCHEMATIC_TERMINAL_GROUP_SCHEMA_VERSION) }, work: budget.snapshot() });
}

export interface FreshSchematicPristineGroup { readonly name: string; readonly endpoints: readonly string[] }

/** Rebuild the candidate partition, then require the exact complete unnamed partition. */
export function validatePristineTerminalPartition(
  input: FreshSchematicTerminalInput,
  readback: readonly FreshSchematicPristineGroup[],
  budget = new FreshSchematicWorkBudget(),
): FreshSchematicTerminalResult<FreshSchematicTerminalPartition> {
  const built = buildSchematicTerminalGroups(input, budget);
  if (built.status !== "complete") return built;
  if (!Array.isArray(readback) || readback.length !== built.value.groups.length || readback.length > 8_192
      || readback.some((group) => !group || !Array.isArray(group.endpoints) || group.endpoints.length === 0 || group.endpoints.length > 128)
      || readback.reduce((sum, group) => sum + group.endpoints.length, 0) > 8_192) {
    return rejected(budget, "PRISTINE_PARTITION_MISMATCH", [], "Pristine readback has an invalid or oversized group inventory.");
  }
  const expected = new Set(built.value.groups.map((group) => JSON.stringify(group.memberEndpointIds)));
  const observed = new Set<string>();
  const allPins = new Set<string>();
  // Sort a detached representation for deterministic mismatch behavior.
  const normalized: { name: string; endpoints: string[] }[] = [];
  // Reserve the whole normalization pass atomically. Per-input-group charges
  // would make exhaustion counters depend on caller permutation before sort.
  const normalizationWork = readback.reduce((sum, group) => sum + 1 + group.endpoints.length, 0);
  if (!budget.charge("partition", normalizationWork)) return exhausted(budget);
  for (const group of readback) {
    if (group.name !== "~unnamed" || group.endpoints.some((id: unknown) => typeof id !== "string" || id.length > 65)) {
      return rejected(budget, "PRISTINE_PARTITION_MISMATCH", [], "Every pristine group must be unnamed with bounded original endpoint IDs.");
    }
    normalized.push({ name: group.name, endpoints: [...group.endpoints].sort(order) });
  }
  normalized.sort((a, b) => order(JSON.stringify(a.endpoints), JSON.stringify(b.endpoints)));
  for (const group of normalized) {
    if (!budget.charge("partition", group.endpoints.length)) return exhausted(budget);
    const key = JSON.stringify(group.endpoints);
    if (!expected.has(key) || observed.has(key) || group.endpoints.some((id) => allPins.has(id))) {
      return rejected(budget, "PRISTINE_PARTITION_MISMATCH", group.endpoints, "Readback splits, merges, duplicates, or adds to the source-proven candidate terminal partition.");
    }
    observed.add(key);
    for (const id of group.endpoints) allPins.add(id);
  }
  if (observed.size !== expected.size || allPins.size !== built.value.endpointToGroup.length) {
    return rejected(budget, "PRISTINE_PARTITION_MISMATCH", [], "Pristine readback is missing original endpoints or complete terminal groups.");
  }
  return freeze({ status: "complete", value: built.value, work: budget.snapshot() });
}

import { z } from "zod";
import { MAX_FRESH_LIVE_BOARD_BYTES } from "./fresh-board-persistence.js";
import { planFreshFootprintPlacement, type FreshFootprintPlacementPlan } from "./fresh-footprint-placement.js";
import { routeSourceMmToNativeNm } from "./fresh-route-native-units.js";

export const FRESH_FOOTPRINT_POSE_BATCH_TOOL = "fresh_set_footprint_poses" as const;
export const FRESH_FOOTPRINT_POSE_BATCH_LIMITS = Object.freeze({ maximumPlacements: 64, maximumSourceBytes: MAX_FRESH_LIVE_BOARD_BYTES });
const argumentsSchema = z.object({ placements: z.array(z.object({
  reference: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u),
  x_mm: z.number().finite().min(-2000).max(2000), y_mm: z.number().finite().min(-2000).max(2000),
  rotation_deg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
}).strict()).min(1).max(FRESH_FOOTPRINT_POSE_BATCH_LIMITS.maximumPlacements) }).strict();
export const FRESH_FOOTPRINT_POSE_BATCH_SCHEMA = Object.freeze(z.toJSONSchema(argumentsSchema));
export type FreshFootprintPoseBatchRequest = Readonly<z.infer<typeof argumentsSchema>["placements"][number]>;
/** Pure planning uses only these already host-bound contract fields. */
export interface FreshFootprintPoseBatchContract {
  readonly components: readonly Readonly<{ reference: string }>[];
  readonly placementConstraints: readonly Readonly<{ reference: string; side: string; allowedRotationsDeg: readonly number[];
    regionMm: Readonly<{ minXmm: number; maxXmm: number; minYmm: number; maxYmm: number }> }>[];
}
export interface FreshFootprintPoseBatchPlan {
  readonly source: string;
  readonly changed: boolean;
  /** Distinct from field plans' updates; no intermediate board strings escape. */
  readonly placements: readonly Readonly<Omit<FreshFootprintPlacementPlan, "source">>[];
}

export function parseFreshFootprintPoses(value: unknown, contract: FreshFootprintPoseBatchContract): readonly FreshFootprintPoseBatchRequest[] {
  const requests = argumentsSchema.parse(value).placements, seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.reference)) throw new Error("Footprint pose batch requires unique references.");
    seen.add(request.reference);
    const component = contract.components.filter(candidate => candidate.reference === request.reference);
    const constraints = contract.placementConstraints.filter(candidate => candidate.reference === request.reference);
    if (component.length !== 1 || constraints.length !== 1 || constraints[0]!.side !== "front"
        || !constraints[0]!.allowedRotationsDeg.includes(request.rotation_deg)) {
      throw new Error("Footprint pose batch reference/front rotation is outside its exact electrical contract.");
    }
    const x = routeSourceMmToNativeNm(request.x_mm), y = routeSourceMmToNativeNm(request.y_mm), region = constraints[0]!.regionMm;
    if (x < routeSourceMmToNativeNm(region.minXmm) || x > routeSourceMmToNativeNm(region.maxXmm)
        || y < routeSourceMmToNativeNm(region.minYmm) || y > routeSourceMmToNativeNm(region.maxYmm)) {
      throw new Error("Footprint pose batch target is outside its declared placement region.");
    }
  }
  return Object.freeze(requests.map(request => Object.freeze(request)));
}

/** Compose proven single-footprint transformations in memory. This does not
 * persist partial edits, establish clearance, or replace native source checks.
 */
export function planFreshFootprintPoses(source: string, value: unknown, contract: FreshFootprintPoseBatchContract): FreshFootprintPoseBatchPlan {
  const requests = parseFreshFootprintPoses(value, contract);
  const bounded = (text: string) => {
    if (typeof text !== "string" || !text.isWellFormed() || text.length === 0
        || Buffer.byteLength(text, "utf8") > FRESH_FOOTPRINT_POSE_BATCH_LIMITS.maximumSourceBytes) {
      throw new Error("Footprint pose batch source exceeds the existing bounded live-board domain.");
    }
  };
  bounded(source);
  let planned = source;
  const placements: Omit<FreshFootprintPlacementPlan, "source">[] = [];
  for (const request of requests) {
    const { source: next, ...placement } = planFreshFootprintPlacement(planned, { reference: request.reference,
      xMm: request.x_mm, yMm: request.y_mm, rotationDeg: request.rotation_deg });
    bounded(next);
    planned = next;
    placements.push(Object.freeze(placement));
  }
  return Object.freeze({ source: planned, changed: placements.some(placement => placement.changed), placements: Object.freeze(placements) });
}

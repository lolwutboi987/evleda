import { z } from "zod";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type { HarnessToolCall, HarnessToolResult } from "../harness/contracts.js";
import { freshSyncV2ResultFieldsSchema, refineFreshPhysicalSyncCounts } from "../harness/pcb-agent-harness.js";

const planeSyncSchemaVersion = "evleda.fresh-plane-sync-from-schematic-result.v1";
const identitySchema = freshSyncV2ResultFieldsSchema.shape.identity;
const planeSyncResultSchema = freshSyncV2ResultFieldsSchema.omit({ genericProjectBindingIdentity: true }).extend({
  schemaVersion: z.literal(planeSyncSchemaVersion),
  planeProjectBindingIdentity: identitySchema.extend({ schemaVersion: z.literal("evleda.pcb-agent-plane-fresh-binding.v1") }).strict(),
  sourceContractIdentity: identitySchema.extend({ schemaVersion: z.literal("evleda.pcb-design-contract.v2") }).strict(),
  identity: identitySchema.extend({ schemaVersion: z.literal(planeSyncSchemaVersion) }).strict(),
}).strict().superRefine(refineFreshPhysicalSyncCounts);
const planeRouteSchemaVersion = "evleda.fresh-plane-route-mutation-result.v1";
const planeRouteResultSchema = z.object({
  schemaVersion: z.literal(planeRouteSchemaVersion),
  contractIdentity: freshSyncV2ResultFieldsSchema.shape.contractIdentity,
  planeProjectBindingIdentity: identitySchema.extend({ schemaVersion: z.literal("evleda.pcb-agent-plane-fresh-binding.v1") }).strict(),
  sourceContractIdentity: identitySchema.extend({ schemaVersion: z.literal("evleda.pcb-design-contract.v2") }).strict(),
  freshMarkerContentIdentity: freshSyncV2ResultFieldsSchema.shape.freshMarkerContentIdentity,
  applied: z.literal(true), mutated: z.literal(true), idempotent: z.literal(false),
  selectionIdentity: identitySchema.extend({ schemaVersion: z.literal("evleda.fresh-plane-route-selection.v1") }).strict(),
  beforePcbContentIdentity: freshSyncV2ResultFieldsSchema.shape.beforePcbContentIdentity,
  livePcbContentIdentity: freshSyncV2ResultFieldsSchema.shape.afterPcbContentIdentity,
  net: z.string().min(1).max(64),
  deletedItemIds: z.array(z.string().min(1).max(128)).max(128),
  addedTrackCount: z.number().int().min(0).max(128), addedViaCount: z.number().int().min(0).max(32),
  completion: z.literal("not_evaluated"), connection: z.literal("not_evaluated"),
  mutationValidity: z.literal("verified"), scope: z.literal("selected-net-incremental-route-geometry"),
  notEvaluated: z.tuple([z.literal("plane_contact"), z.literal("clearance"), z.literal("reference_coverage"), z.literal("completed_route_topology")]),
  issues: z.tuple([]),
  identity: identitySchema.extend({ schemaVersion: z.literal(planeRouteSchemaVersion) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.deletedItemIds.length + value.addedTrackCount + value.addedViaCount === 0
      || canonicalJson(value.deletedItemIds) !== canonicalJson([...new Set(value.deletedItemIds)].sort())) {
    context.addIssue({ code: "custom", message: "Plane route mutation requires an effect and sorted unique deletion IDs." });
  }
});

export interface PlaneCompoundMutationContext {
  readonly connectivityIdentity: CanonicalIdentity;
  readonly projectBindingIdentity: CanonicalIdentity;
  readonly sourceContractIdentity: CanonicalIdentity;
}

const planeApplySchemaVersion = "evleda.fresh-plane-apply-result.v1";
const planeApplyArgumentsSchema = z.object({ planeId: z.string().min(1).max(64).optional() }).strict();
const planeApplyResultSchema = z.object({
  schemaVersion: z.literal(planeApplySchemaVersion),
  contractIdentity: freshSyncV2ResultFieldsSchema.shape.contractIdentity,
  planeProjectBindingIdentity: identitySchema.extend({ schemaVersion: z.literal("evleda.pcb-agent-plane-fresh-binding.v1") }).strict(),
  sourceContractIdentity: identitySchema.extend({ schemaVersion: z.literal("evleda.pcb-design-contract.v2") }).strict(),
  freshMarkerContentIdentity: freshSyncV2ResultFieldsSchema.shape.freshMarkerContentIdentity,
  planeId: z.string().min(1).max(64), targetZoneUuid: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
  operation: z.enum(["create", "update"]),
  preparedSpecIdentity: identitySchema.extend({ schemaVersion: z.literal("evleda.fresh-plane-mutation-spec.v1") }).strict(),
  beforePcbContentIdentity: freshSyncV2ResultFieldsSchema.shape.beforePcbContentIdentity.extend({ size: z.number().int().positive().max(1_048_576) }).strict(),
  stagedPcbContentIdentity: freshSyncV2ResultFieldsSchema.shape.afterPcbContentIdentity.extend({ size: z.number().int().positive().max(1_048_576) }).strict(),
  stageReceiptIdentity: freshSyncV2ResultFieldsSchema.shape.receivedSidecarResponseIdentity.extend({ size: z.number().int().positive().max(8_388_608) }).strict(),
  mutationComparisonIdentity: identitySchema.extend({ schemaVersion: z.literal("evleda.fresh-plane-mutation-comparison.v1") }).strict(),
  requirements: z.object({
    minimumIslandAreaMm2: z.number().nonnegative(), minimumAreaEnforcement: z.literal("not-enforced-by-always-mode"),
    minimumSpokes: z.number().int().min(1).max(4).nullable(),
    spokeEnforcement: z.enum(["external-owned-rule-and-native-evidence", "not-applicable"]),
  }).strict().superRefine((value, context) => {
    if ((value.minimumSpokes === null) !== (value.spokeEnforcement === "not-applicable")) context.addIssue({ code: "custom", message: "Spoke requirements must match their enforcement mode." });
  }),
  applied: z.literal(true), mutated: z.literal(true), idempotent: z.literal(false), nativeActionsPerformed: z.literal(true), sourceChanged: z.boolean(),
  completion: z.literal("not_evaluated"), connection: z.literal("not_evaluated"), referenceCoverage: z.literal("not_evaluated"),
  thermalAcceptance: z.literal("not_evaluated"), islandAreaAcceptance: z.literal("not_evaluated"),
  nativeSaveCalledByStage: z.literal(false), acceptanceEvaluated: z.literal(false), issues: z.tuple([]),
  identity: identitySchema.extend({ schemaVersion: z.literal(planeApplySchemaVersion) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.sourceChanged !== (canonicalJson(value.beforePcbContentIdentity) !== canonicalJson(value.stagedPcbContentIdentity))) {
    context.addIssue({ code: "custom", message: "Plane sourceChanged must match the exact before and staged content identities." });
  }
});

/** Plane authority is checked only at the direct toolbox boundary, never by the legacy harness. */
export const planeCompoundMutationState = (
  call: HarnessToolCall,
  result: HarnessToolResult,
  expected: PlaneCompoundMutationContext,
): boolean | undefined => {
  if (!["fresh_sync_from_schematic", "fresh_replace_route_items", "fresh_apply_contract_plane"].includes(call.name)) return undefined;
  const sync = call.name === "fresh_sync_from_schematic";
  const apply = call.name === "fresh_apply_contract_plane";
  const operation = sync ? "Plane sync" : apply ? "Plane apply" : "Plane route";
  if (result.isError) throw new Error(`${operation} returned an error; mutation and save are not authorized.`);
  if (sync && (call.arguments === null || typeof call.arguments !== "object" || Array.isArray(call.arguments) || Object.keys(call.arguments).length !== 0)) {
    throw new Error("Plane sync requires an empty-argument request.");
  }
  let value: unknown;
  try { value = JSON.parse(result.content) as unknown; }
  catch (error) { throw new Error(`${operation} returned invalid JSON.`, { cause: error }); }
  const parsed = sync ? planeSyncResultSchema.safeParse(value) : apply ? planeApplyResultSchema.safeParse(value) : planeRouteResultSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${operation} returned an invalid host board-mutation result: ${parsed.error.issues.slice(0, 8).map((issue) => issue.message).join("; ")}`);
  const { identity, ...payload } = parsed.data;
  if (canonicalJson(payload.contractIdentity) !== canonicalJson(expected.connectivityIdentity)
      || canonicalJson(payload.planeProjectBindingIdentity) !== canonicalJson(expected.projectBindingIdentity)
      || canonicalJson(payload.sourceContractIdentity) !== canonicalJson(expected.sourceContractIdentity)) {
    throw new Error(`${operation} result does not match its host-bound connectivity, project, and source contract identities.`);
  }
  if (apply) {
    const args = planeApplyArgumentsSchema.safeParse(call.arguments);
    const applied = parsed.data as z.infer<typeof planeApplyResultSchema>;
    if (!args.success || (args.data.planeId !== undefined && args.data.planeId !== applied.planeId)) {
      throw new Error("Plane apply result does not bind its exact plane selection request.");
    }
  } else if (!sync) {
    const route = parsed.data as z.infer<typeof planeRouteResultSchema>;
    const args = call.arguments;
    if (!Array.isArray(args.deleteItemIds) || !args.deleteItemIds.every((id) => typeof id === "string")
        || !Array.isArray(args.tracks) || !Array.isArray(args.vias)
        || args.selectionIdentity === undefined || args.net === undefined
        || canonicalJson(route.selectionIdentity) !== canonicalJson(args.selectionIdentity)
        || route.net !== args.net
        || canonicalJson(route.deletedItemIds) !== canonicalJson([...args.deleteItemIds].sort())
        || route.addedTrackCount !== args.tracks.length || route.addedViaCount !== args.vias.length) {
      throw new Error("Plane route result does not bind its exact selection, net, deletion, and addition request.");
    }
  }
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, parsed.data.schemaVersion))) {
    throw new Error(`${operation} result identity does not reproduce from its closed payload.`);
  }
  return parsed.data.mutated;
};

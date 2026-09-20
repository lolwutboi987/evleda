import { z } from "zod";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type { KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";
import { parseFreshPcbSource } from "../harness/fresh-kicad-parser.js";
import { readPlaneFreshProjectBaselineHashes, type PlaneFreshProject } from "../harness/fresh-project.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "../harness/pcb-design-plane-bundle.js";
import { freezePcbPlaneArtifact } from "../harness/pcb-design-plane-contract.js";
import { issueFreshPlanePlacementSeed, freshPlanePlacementSeedPlan } from "../harness/fresh-plane-placement-seed.js";
import type { PlaneRevisionKind } from "../harness/fresh-plane-placement-revision.js";
import { captureClosedPlaneSeedSnapshot, schematicSeedLineageSchema, type ClosedPlaneSeedSourceContext } from "./toolbox-schematic-seed.js";

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const requireValue = (v: unknown, message: string): void => { if (!v) throw new Error(`Placement revision source: ${message}`); };
const content = schematicSeedLineageSchema.shape.sourceCheckpointIdentity;
const nativeIdentities = z.object({ pcb: content, sch: content, pro: content, dru: content }).strict();
export const placementRevisionLineageSchema = schematicSeedLineageSchema.omit({ schemaVersion: true, sourceSchematicIdentity: true }).extend({
  schemaVersion: z.enum(["evleda.plane-placement-revision-lineage.v1", "evleda.plane-via-budget-revision-lineage.v1", "evleda.plane-region-policy-revision-lineage.v1", "evleda.plane-saved-recovery-lineage.v1"]), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
  sourceNativeIdentities: nativeIdentities, targetNativeIdentities: nativeIdentities,
  sourcePlanIdentity: schematicSeedLineageSchema.shape.sourceSnapshotIdentity,
  recovery: z.object({ evidenceIdentity: schematicSeedLineageSchema.shape.sourceSnapshotIdentity,
    sourceCheckpointCurrent: z.literal(false), sourceNormalCloseConfirmed: z.literal(false), sourceQuarantineRetained: z.literal(true) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.schemaVersion === "evleda.plane-saved-recovery-lineage.v1") !== (value.recovery !== undefined))
    context.addIssue({ code: "custom", message: "Recovery lineage must carry its distinct failed-session evidence; normal revision lineage must not." });
});
export type PlacementRevisionLineage = z.infer<typeof placementRevisionLineageSchema>;
export function parsePlacementRevisionLineage(value: unknown): PlacementRevisionLineage {
  const parsed = placementRevisionLineageSchema.parse(value), { identity, ...payload } = parsed;
  requireValue(parsed.sourceProjectId !== parsed.targetProjectId && equal(identity, canonicalIdentity(payload, parsed.schemaVersion)), "lineage identity or project selection differs");
  return freezePcbPlaneArtifact(parsed);
}
export async function assertPlacementRevisionBaseline(project: PlaneFreshProject, bundle: PcbPlaneCompilationBundle,
  input: PlacementRevisionLineage): Promise<PlacementRevisionLineage> {
  const lineage = parsePlacementRevisionLineage(input);
  requireValue(lineage.name === project.name && equal(lineage.targetBundleIdentity, bundle.identity), "baseline belongs to another project name or bundle");
  const baseline = await readPlaneFreshProjectBaselineHashes(project, bundle);
  for (const key of ["pcb", "sch", "pro", "dru"] as const) requireValue(baseline[key] === lineage.targetNativeIdentities[key].digest,
    `immutable ${key} baseline differs from the allocation lineage`);
  return lineage;
}
export interface ClosedPlanePlacementRevisionSource { readonly kind: "same-connection-closed-placement-source" }
const closed = new WeakMap<object, { context: ClosedPlaneSeedSourceContext; identity: CanonicalIdentity }>();

/** Called only by the genuine binding after native close/checkpoint, with its lease held. */
export async function captureClosedPlanePlacementRevisionSource(input: ClosedPlaneSeedSourceContext): Promise<ClosedPlanePlacementRevisionSource | undefined> {
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(input.bundle), "source bundle is unauthenticated");
  const context = Object.freeze({ ...input, profile: freezePcbPlaneArtifact(structuredClone(input.profile)) }), captured = await captureClosedPlaneSeedSnapshot(context);
  const board = parseFreshPcbSource(captured.files.pcb!.bytes.toString("utf8"));
  const expected = [...input.bundle.contract.components.map(c => c.reference), ...(input.bundle.contract.boardFeatures ?? []).map(f => f.reference)].sort();
  if (!equal(board.footprints.map(f => f.reference).sort(), expected)) return undefined;
  const receipt: ClosedPlanePlacementRevisionSource = Object.freeze({ kind: "same-connection-closed-placement-source" });
  closed.set(receipt, { context, identity: captured.identity });
  return receipt;
}
export async function assertClosedPlanePlacementRevisionSourceCurrent(receipt: ClosedPlanePlacementRevisionSource): Promise<void> {
  const state = closed.get(receipt); requireValue(state !== undefined, "source has no genuine close in this workspace connection");
  requireValue(equal((await captureClosedPlaneSeedSnapshot(state!.context)).identity, state!.identity), "source changed after its successful close");
}
export async function qualifyClosedPlanePlacementRevision(input: {
  readonly receipt: ClosedPlanePlacementRevisionSource; readonly sourceProjectId: string; readonly sourceOutputDir: string;
  readonly targetProjectId: string; readonly name: string; readonly targetBundle: PcbPlaneCompilationBundle;
  readonly profile: KicadMcpPinnedFileInput; readonly assertLeaseCurrent: () => Promise<void>;
  readonly revisionKind?: PlaneRevisionKind;
}) {
  requireValue(input.revisionKind === undefined || input.revisionKind === "placement" || input.revisionKind === "via-budgets" || input.revisionKind === "plane-regions",
    "saved-copy recovery is not an ordinary public revision");
  const state = closed.get(input.receipt); requireValue(state !== undefined, "source has no genuine close in this workspace connection");
  const context = state!.context;
  requireValue(input.sourceProjectId !== input.targetProjectId && context.project.outputPath === input.sourceOutputDir
    && context.project.name === input.name && equal(context.profile, input.profile), "name, allocation or native profile differs");
  const assertCurrent = async () => { await input.assertLeaseCurrent(); await assertClosedPlanePlacementRevisionSourceCurrent(input.receipt); await input.assertLeaseCurrent(); };
  await assertCurrent();
  const captured = await captureClosedPlaneSeedSnapshot(context);
  requireValue(equal(captured.identity, state!.identity), "source changed during qualification");
  const sourceText = (key: "pcb" | "sch" | "pro" | "dru") => {
    const bytes = captured.files[key]!.bytes, source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    requireValue(Buffer.from(source).equals(bytes), "source must round-trip exact scalar UTF-8"); return source;
  };
  const seed = issueFreshPlanePlacementSeed({ name: input.name, sourceBundle: context.bundle, targetBundle: input.targetBundle,
    sources: { pcb: sourceText("pcb"), sch: sourceText("sch"), pro: sourceText("pro"), dru: sourceText("dru") }, profile: input.profile, assertCurrent,
    ...(input.revisionKind === undefined ? {} : { revisionKind: input.revisionKind }) });
  const plan = freshPlanePlacementSeedPlan(seed);
  const payload = { schemaVersion: input.revisionKind === "via-budgets" ? "evleda.plane-via-budget-revision-lineage.v1" as const
    : input.revisionKind === "plane-regions" ? "evleda.plane-region-policy-revision-lineage.v1" as const
    : "evleda.plane-placement-revision-lineage.v1" as const, name: input.name,
    sourceProjectId: input.sourceProjectId, targetProjectId: input.targetProjectId,
    sourceBundleIdentity: context.bundle.identity, targetBundleIdentity: input.targetBundle.identity,
    sourceSnapshotIdentity: captured.identity, sourceCheckpointIdentity: captured.files.checkpoint!.identity,
    sourceNativeIdentities: plan.receipt.sourceIdentities, targetNativeIdentities: plan.receipt.targetIdentities,
    sourcePlanIdentity: plan.receipt.identity, nativeProfileIdentity: captured.files.profile!.identity };
  const lineage = parsePlacementRevisionLineage({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  await assertCurrent();
  return Object.freeze({ seed, lineage, assertCurrent });
}

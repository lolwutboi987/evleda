import path from "node:path";
import { canonicalJson } from "../core/canonical.js";
import type { KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";
import { planPlanePlacementRevisionSources, type PlanePlacementRevisionSources, type PlaneSourceSeedKind } from "./fresh-plane-placement-revision.js";
import type { PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";

export interface FreshPlanePlacementSeed { readonly kind: "qualified-plane-placement-revision" }
type Plan = ReturnType<typeof planPlanePlacementRevisionSources>;
interface State {
  readonly plan: Plan;
  readonly name: string;
  readonly bundle: string;
  readonly profile: string;
  readonly assertCurrent: () => Promise<void>;
  target?: string;
}
const seeds = new WeakMap<object, State>();
const requireValue = (value: unknown, message: string): void => { if (!value) throw new Error(`Placement seed: ${message}`); };
const state = (seed: FreshPlanePlacementSeed): State => {
  const value = seeds.get(seed); requireValue(value !== undefined, "capability was not issued by this host"); return value!;
};

/** Host-only issuer. Ordinary revisions require a qualified closed source and
 * its current lease. The separately typed operator recovery path instead binds
 * a quiescent, quarantined saved snapshot and preserves the original quarantine.
 * Either caller must enforce currentness throughout preparation and native open. */
export function issueFreshPlanePlacementSeed(input: {
  readonly name: string;
  readonly sourceBundle: PcbPlaneCompilationBundle;
  readonly targetBundle: PcbPlaneCompilationBundle;
  readonly sources: PlanePlacementRevisionSources;
  readonly profile: KicadMcpPinnedFileInput;
  readonly assertCurrent: () => Promise<void>;
  readonly revisionKind?: PlaneSourceSeedKind;
}): FreshPlanePlacementSeed {
  const plan = planPlanePlacementRevisionSources(input), seed: FreshPlanePlacementSeed = Object.freeze({ kind: "qualified-plane-placement-revision" });
  seeds.set(seed, { plan, name: input.name, bundle: canonicalJson(input.targetBundle.identity),
    profile: canonicalJson(input.profile), assertCurrent: input.assertCurrent });
  return seed;
}
export function freshPlanePlacementSeedPlan(seed: FreshPlanePlacementSeed): Plan { return state(seed).plan; }
export function assertFreshPlanePlacementSeedProfile(seed: FreshPlanePlacementSeed, profile: KicadMcpPinnedFileInput): void {
  requireValue(state(seed).profile === canonicalJson(profile), "target native profile differs from the closed source profile");
}
export async function assertFreshPlanePlacementSeedCurrent(seed: FreshPlanePlacementSeed): Promise<void> { await state(seed).assertCurrent(); }
export async function consumeFreshPlanePlacementSeed(seed: FreshPlanePlacementSeed, outputDir: string, name: string,
  bundle: PcbPlaneCompilationBundle): Promise<PlanePlacementRevisionSources> {
  const value = state(seed);
  requireValue(value.target === undefined && value.name === name && value.bundle === canonicalJson(bundle.identity),
    "reused or differently bound seed capability");
  value.target = path.resolve(outputDir);
  await value.assertCurrent();
  return value.plan.sources;
}
export function assertFreshPlanePlacementSeedBaseline(seed: FreshPlanePlacementSeed, outputDir: string,
  sources: PlanePlacementRevisionSources): void {
  const value = state(seed);
  requireValue(value.target === path.resolve(outputDir) && canonicalJson(value.plan.sources) === canonicalJson(sources),
    "prepared source bytes differ from their one-invocation seed authority");
}
export function assertFreshPlanePlacementSeedPcb(seed: FreshPlanePlacementSeed, outputDir: string, pcbIdentity: unknown): void {
  assertFreshPlanePlacementSeedFile(seed, outputDir, "pcb", pcbIdentity);
}
export function assertFreshPlanePlacementSeedFile(seed: FreshPlanePlacementSeed, outputDir: string,
  key: keyof PlanePlacementRevisionSources, identity: unknown): void {
  const value = state(seed);
  requireValue(value.target === path.resolve(outputDir) && canonicalJson(value.plan.receipt.targetIdentities[key]) === canonicalJson(identity),
    `authored Open does not match its qualified placement seed ${key}`);
}

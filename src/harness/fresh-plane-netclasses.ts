import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { KicadExecutableIdentity } from "../integrations/kicad-cli.js";
import { FRESH_NETCLASS_ASSIGNMENT_MODEL } from "./fresh-netclass-assignment.js";
import { FreshClearanceEvidenceError, FRESH_CLEARANCE_EVIDENCE_LIMITS, freshNetClassPreparationMechanics as mechanics,
  type FreshNetClassMaterialization, type FreshNetClassSemanticAuthority, type FreshNetClassPreparationEvidence } from "./fresh-clearance-evidence.js";
import { PCB_PLANE_BUNDLE_SCHEMA_VERSION, isAuthenticatedPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef,
  type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { PCB_PLANE_CONTRACT_SCHEMA_VERSION, freezePcbPlaneArtifact } from "./pcb-design-plane-contract.js";
import { PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION, createPlaneFreshProjectBinding, isVerifiedPlaneFreshProject,
  type PlaneFreshProject } from "./fresh-project.js";
import { createFreshPlaneRules } from "./fresh-plane-rules.js";

export const FRESH_PLANE_NETCLASS_MATERIALIZATION_SCHEMA_VERSION = "evleda.fresh-plane-netclass-materialization.v1" as const;
export const FRESH_PLANE_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION = "evleda.fresh-plane-netclass-semantic-authority.v1" as const;
export const FRESH_PLANE_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION = "evleda.fresh-plane-netclass-preparation-evidence.v1" as const;
const evaluation = Object.freeze({ zones: "not-evaluated" as const, planeClearance: "not-evaluated" as const });
const resolution = Object.freeze({ boardMinimum: "absolute-floor" as const, netClassConflict: "larger-clearance" as const,
  customRules: "exact-bundle-owned-plane-rules" as const, localPadOrFootprintOverrides: "clearance-only-rejected" as const,
  localThermalOverrides: "not-evaluated" as const,
  ...evaluation, ...FRESH_NETCLASS_ASSIGNMENT_MODEL });
interface PlaneBoundary {
  readonly family: "plane-v2";
  readonly classification: "candidate-configuration";
  readonly acceptanceEvaluated: false;
  readonly planeProjectBindingIdentity: CanonicalIdentity;
  readonly customRulesIdentity: ContentIdentity;
  readonly evaluation: typeof evaluation;
}
/** Shared KiCad record types only; these are never converted or stamped from a V1 artifact. */
export interface FreshPlaneNetClassMaterialization extends Omit<FreshNetClassMaterialization, "schemaVersion" | "classification" | "genericProjectBindingIdentity" | "customRulesIdentity">, PlaneBoundary {
  readonly schemaVersion: typeof FRESH_PLANE_NETCLASS_MATERIALIZATION_SCHEMA_VERSION;
}
export interface FreshPlaneNetClassSemanticAuthority extends Omit<FreshNetClassSemanticAuthority, "schemaVersion" | "classification" | "genericProjectBindingIdentity" | "ruleResolution">, PlaneBoundary {
  readonly schemaVersion: typeof FRESH_PLANE_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION;
  readonly ruleResolution: typeof resolution;
}
export interface FreshPlaneNetClassPreparationEvidence extends Omit<FreshNetClassPreparationEvidence, "schemaVersion" | "classification" | "genericProjectBindingIdentity">, PlaneBoundary {
  readonly schemaVersion: typeof FRESH_PLANE_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION;
}
export interface FreshPlaneNetClassOperationOptions {
  readonly project: PlaneFreshProject;
  readonly compilationBundle: PcbPlaneCompilationBundle;
  readonly kicad: KicadExecutableIdentity;
}

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const fail = (code: ConstructorParameters<typeof FreshClearanceEvidenceError>[0], message: string): never => { throw new FreshClearanceEvidenceError(code, message); };
const withIdentity = <Value extends { readonly schemaVersion: string }>(payload: Value) =>
  freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });

function operation(input: FreshPlaneNetClassOperationOptions) {
  const { project, compilationBundle, kicad } = input;
  if (!isVerifiedPlaneFreshProject(project)) return fail("UNVERIFIED_PROJECT", "Plane net-class preparation requires an original verified PlaneFreshProject capability.");
  if (!isAuthenticatedPcbPlaneCompilationBundle(compilationBundle)) return fail("UNVERIFIED_BUNDLE", "Plane net-class preparation requires an authenticated actual V2 plane bundle.");
  const reference = createPcbPlaneCompilationBundleRef(compilationBundle);
  const expectedBinding = createPlaneFreshProjectBinding(compilationBundle, reference).binding;
  if (!same(project.planeBinding, expectedBinding)) return fail("UNVERIFIED_BUNDLE", "Plane project binding differs from the exact V2 bundle and its dependencies.");
  const rules = createFreshPlaneRules(compilationBundle);
  const expectedRuleBytes = Buffer.from(rules.source, "utf8");
  return {
    project, compilationBundle, kicad, zones: "not-evaluated" as const,
    authenticateMarker: async (bytes: Buffer): Promise<void> => {
      const actual = await project.assertMarkerCurrent();
      if (!same(actual, contentIdentity(bytes))) return fail("UNVERIFIED_PROJECT", "Captured V3 marker differs from the original PlaneFreshProject authority.");
      if (!same(project.planeBinding, expectedBinding)) return fail("UNVERIFIED_PROJECT", "Plane project binding changed during net-class preparation.");
    },
    validateCustomRules: (source: Readonly<{ bytes: Buffer; identity: ContentIdentity }> | null): void => {
      if (source === null || !source.bytes.equals(expectedRuleBytes) || !same(source.identity, rules.identity)) {
        fail("UNSUPPORTED_RULES", "Plane custom rules must be the exact canonical V2 bundle-owned file created with the original project.");
      }
    },
  };
}
const common = (options: FreshPlaneNetClassOperationOptions, marker: ContentIdentity, customRulesIdentity: ContentIdentity) => ({
  family: "plane-v2" as const, classification: "candidate-configuration" as const, origin: "host" as const,
  acceptanceEvaluated: false as const, fabricationAuthorized: false as const, qualificationEstablished: false as const, releaseAuthorized: false as const,
  bundleIdentity: options.compilationBundle.identity, contractIdentity: options.compilationBundle.contract.identity,
  planeProjectBindingIdentity: options.project.planeBinding.identity, freshMarkerContentIdentity: marker, customRulesIdentity, evaluation,
});

/** Only the project JSON is written. The marker-owned canonical rule file is verified, never replaced. */
export async function materializeFreshPlaneNetClasses(options: FreshPlaneNetClassOperationOptions): Promise<FreshPlaneNetClassMaterialization> {
  const context = operation(options);
  return mechanics.materialize(context, ({ changed, kicad, before, after, bindings }) => withIdentity({
    schemaVersion: FRESH_PLANE_NETCLASS_MATERIALIZATION_SCHEMA_VERSION, ...common(context, after.marker.identity, after.customRules!.identity),
    assignmentModel: FRESH_NETCLASS_ASSIGNMENT_MODEL, changed, kicad,
    preimageProjectSettingsIdentity: before.projectSettings.identity, projectSettingsIdentity: after.projectSettings.identity,
    pcbIdentityAtMaterialization: after.pcb.identity, netClasses: bindings,
  }));
}

/** Exact native class definitions and exclusive assignments; not a zone/plane-clearance result. */
export async function readFreshPlaneNetClassSemanticAuthority(options: FreshPlaneNetClassOperationOptions): Promise<FreshPlaneNetClassSemanticAuthority> {
  const context = operation(options);
  const current = await mechanics.read(context);
  return withIdentity({ schemaVersion: FRESH_PLANE_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION,
    ...common(context, current.sources.marker.identity, current.sources.customRules!.identity), kicad: current.kicad,
    ruleResolution: resolution, boardMinimumClearanceMm: current.configured.boardMinimumClearanceMm,
    netClasses: current.netClasses, contractNetAssignments: current.contractNetAssignments,
  });
}

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const canonical = z.object({ algorithm: z.literal("sha256"), digest, schemaVersion: z.string().min(1).max(256), canonicalizationVersion: z.literal("evleda-c14n-json-v1") }).strict();
const content = z.object({ algorithm: z.literal("sha256"), digest, size: z.number().int().positive().max(FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumPcbBytes) }).strict();
const boundary = {
  family: z.literal("plane-v2"), classification: z.literal("candidate-configuration"), origin: z.literal("host"),
  acceptanceEvaluated: z.literal(false), fabricationAuthorized: z.literal(false), qualificationEstablished: z.literal(false), releaseAuthorized: z.literal(false),
  bundleIdentity: canonical, contractIdentity: canonical, planeProjectBindingIdentity: canonical,
  freshMarkerContentIdentity: content, customRulesIdentity: content, kicad: z.unknown(),
  evaluation: z.object({ zones: z.literal("not-evaluated"), planeClearance: z.literal("not-evaluated") }).strict(), identity: canonical,
};
const materializationSchema = z.object({ ...boundary, schemaVersion: z.literal(FRESH_PLANE_NETCLASS_MATERIALIZATION_SCHEMA_VERSION),
  assignmentModel: z.unknown(), changed: z.boolean(), preimageProjectSettingsIdentity: content, projectSettingsIdentity: content,
  pcbIdentityAtMaterialization: content, netClasses: z.array(z.unknown()).min(1).max(32) }).strict();
const semanticSchema = z.object({ ...boundary, schemaVersion: z.literal(FRESH_PLANE_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION),
  ruleResolution: z.unknown(), boardMinimumClearanceMm: z.number().finite().min(0).max(10).refine(value => !Object.is(value, -0)),
  netClasses: z.array(z.unknown()).min(1).max(32), contractNetAssignments: z.array(z.object({
    netName: z.string().min(1).max(64), contractNetClassId: z.string().min(1).max(64), kicadNetClassName: z.string().min(1).max(256),
  }).strict()).min(1).max(128) }).strict();
const preparationSchema = z.object({ ...boundary, schemaVersion: z.literal(FRESH_PLANE_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION),
  materializationIdentity: canonical, semanticAuthorityIdentity: canonical }).strict();

function snapshot<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  try { return schema.parse(mechanics.snapshotArtifact(input, "Plane net-class artifact")); }
  catch (error) {
    if (error instanceof FreshClearanceEvidenceError) throw error;
    return fail("INVALID_INPUT", "Plane net-class artifact does not match its closed V2-family schema.");
  }
}
function validateCommon(value: Record<string, unknown>, schemaVersion: string): void {
  mechanics.validateCanonicalIdentity(value.bundleIdentity, "plane.bundleIdentity", PCB_PLANE_BUNDLE_SCHEMA_VERSION);
  mechanics.validateCanonicalIdentity(value.contractIdentity, "plane.contractIdentity", PCB_PLANE_CONTRACT_SCHEMA_VERSION);
  mechanics.validateCanonicalIdentity(value.planeProjectBindingIdentity, "plane.planeProjectBindingIdentity", PLANE_FRESH_PROJECT_BINDING_SCHEMA_VERSION);
  mechanics.validateContentIdentity(value.freshMarkerContentIdentity, "plane.freshMarkerContentIdentity", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumMarkerBytes);
  mechanics.validateContentIdentity(value.customRulesIdentity, "plane.customRulesIdentity", FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumRulesBytes);
  mechanics.validateKicadAuthority(value.kicad, "plane.kicad");
  mechanics.validatePayloadIdentity(value, schemaVersion, "Plane net-class artifact");
}

export function parseFreshPlaneNetClassMaterialization(input: unknown): FreshPlaneNetClassMaterialization {
  const value = snapshot(materializationSchema, input);
  validateCommon(value, FRESH_PLANE_NETCLASS_MATERIALIZATION_SCHEMA_VERSION);
  if (!same(value.assignmentModel, FRESH_NETCLASS_ASSIGNMENT_MODEL) || value.changed === same(value.preimageProjectSettingsIdentity, value.projectSettingsIdentity)) {
    return fail("INVALID_INPUT", "Plane materialization has inconsistent assignment or changed-source metadata.");
  }
  for (const key of ["preimageProjectSettingsIdentity", "projectSettingsIdentity"] as const) mechanics.validateContentIdentity(value[key], key, FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes);
  mechanics.validateBindings(value.netClasses, "plane.netClasses", value.bundleIdentity);
  return freezePcbPlaneArtifact(value) as unknown as FreshPlaneNetClassMaterialization;
}

export function parseFreshPlaneNetClassSemanticAuthority(input: unknown): FreshPlaneNetClassSemanticAuthority {
  const value = snapshot(semanticSchema, input);
  validateCommon(value, FRESH_PLANE_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
  if (!same(value.ruleResolution, resolution)) return fail("INVALID_INPUT", "Plane semantic authority cannot claim V1 zone rejection or evaluated plane clearance.");
  const definitions = value.netClasses.map((entry, index) => mechanics.validateSemanticDefinition(entry, `plane.netClasses[${index}]`));
  for (const [index, assignment] of value.contractNetAssignments.entries()) {
    if (index > 0 && value.contractNetAssignments[index - 1]!.netName >= assignment.netName) return fail("INVALID_INPUT", "Plane assignments must be globally unique and sorted.");
  }
  const bindings = mechanics.projectBindings(definitions, value.contractNetAssignments);
  mechanics.validateBindings(bindings, "plane.semanticBindings", value.bundleIdentity);
  return freezePcbPlaneArtifact(value) as unknown as FreshPlaneNetClassSemanticAuthority;
}

export function createFreshPlaneNetClassPreparationEvidence(materializationInput: FreshPlaneNetClassMaterialization,
  semanticInput: FreshPlaneNetClassSemanticAuthority): FreshPlaneNetClassPreparationEvidence {
  const materialization = parseFreshPlaneNetClassMaterialization(materializationInput);
  const semantic = parseFreshPlaneNetClassSemanticAuthority(semanticInput);
  for (const key of ["bundleIdentity", "contractIdentity", "planeProjectBindingIdentity", "freshMarkerContentIdentity", "customRulesIdentity", "kicad"] as const) {
    if (!same(materialization[key], semantic[key])) return fail("INVALID_INPUT", `Plane preparation child artifacts disagree on ${key}.`);
  }
  const bindings = mechanics.projectBindings(semantic.netClasses, semantic.contractNetAssignments);
  if (!same(bindings, materialization.netClasses)) return fail("INVALID_INPUT", "Plane preparation child artifacts disagree on managed classes or exclusive assignments.");
  return withIdentity({ schemaVersion: FRESH_PLANE_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION,
    family: semantic.family, classification: semantic.classification, origin: semantic.origin, acceptanceEvaluated: false,
    fabricationAuthorized: false, qualificationEstablished: false, releaseAuthorized: false,
    bundleIdentity: semantic.bundleIdentity, contractIdentity: semantic.contractIdentity, planeProjectBindingIdentity: semantic.planeProjectBindingIdentity,
    freshMarkerContentIdentity: semantic.freshMarkerContentIdentity, customRulesIdentity: semantic.customRulesIdentity, kicad: semantic.kicad,
    evaluation, materializationIdentity: materialization.identity, semanticAuthorityIdentity: semantic.identity,
  });
}

export function parseFreshPlaneNetClassPreparationEvidence(input: unknown): FreshPlaneNetClassPreparationEvidence {
  const value = snapshot(preparationSchema, input);
  validateCommon(value, FRESH_PLANE_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION);
  mechanics.validateCanonicalIdentity(value.materializationIdentity, "plane.materializationIdentity", FRESH_PLANE_NETCLASS_MATERIALIZATION_SCHEMA_VERSION);
  mechanics.validateCanonicalIdentity(value.semanticAuthorityIdentity, "plane.semanticAuthorityIdentity", FRESH_PLANE_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
  return freezePcbPlaneArtifact(value) as unknown as FreshPlaneNetClassPreparationEvidence;
}

export async function verifyFreshPlaneNetClassSemanticAuthority(input: unknown, options: FreshPlaneNetClassOperationOptions): Promise<FreshPlaneNetClassSemanticAuthority> {
  const supplied = parseFreshPlaneNetClassSemanticAuthority(input);
  const current = await readFreshPlaneNetClassSemanticAuthority(options);
  if (!same(supplied, current)) return fail("SOURCE_DRIFT", "Plane semantic authority differs from current authenticated project, rules, bundle or KiCad semantics.");
  return current;
}

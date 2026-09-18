import { PCB_EXTERNAL_POWER_EXECUTION_GUIDANCE } from "./pcb-external-power.js";
import { PCB_DERIVED_POWER_EXECUTION_GUIDANCE, PCB_EXTERNAL_DIODE_POWER_EXECUTION_GUIDANCE } from "./pcb-derived-power.js";
import { PCB_FEED_THROUGH_EXECUTION_GUIDANCE } from "./pcb-channel-feed-through.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { capturePortableRawBytes, decodeCapturedPortableUtf8, parseCapturedPortableJsonBytes } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  compilePcbPlaneDesignIntentDraft, normalizePcbPlaneSelectionPolicy, PCB_PLANE_COMPILER_ID,
  type PcbPlaneCompilerOptions, type PcbPlaneDesignCompilation, type PcbPlaneReadyCompilation,
} from "./pcb-design-plane-compiler.js";
import { freezePcbPlaneArtifact, snapshotPcbPlaneValue } from "./pcb-design-plane-contract.js";
import { PCB_INTERFACE_EXECUTION_GUIDANCE, PCB_CHANNEL_EXECUTION_GUIDANCE } from "./pcb-interface-requirements.js";

export const PCB_PLANE_BUNDLE_SCHEMA_VERSION = "evleda.pcb-design-compilation-bundle.v2" as const;
export const PCB_PLANE_BUNDLE_REF_SCHEMA_VERSION = "evleda.pcb-design-compilation-bundle-ref.v2" as const;
export const PCB_PLANE_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const authenticated = new WeakSet<object>();
/** In-process authority only; copied/deserialized bundle shapes are not authenticated. */
export function isAuthenticatedPcbPlaneCompilationBundle(value: unknown): value is PcbPlaneCompilationBundle {
  return value !== null && typeof value === "object" && authenticated.has(value);
}
const guidance = "This bundle is the complete V2 plane contract, not a V1 contract with an amendment. Preserve exact schematic assignments. "
  + "A plane-topology net requires its declared authored zone, current native fill, exact physical terminal connectivity, access routing, clearance, thermal and island evidence. "
  + "A trace tree or existing GND name cannot substitute for that evidence. Trace reference requirements need source-bound filled-copper coverage including voids and the declared return terminals. "
  + "Stackup observations and analytical transmission-line calculations remain supplementary; they do not prove a saved reference plane or impedance. "
  + "Compilation evaluates no acceptance requirement and authorizes no fabrication or release.";

export interface PcbPlaneCompilationBundle {
  readonly schemaVersion: typeof PCB_PLANE_BUNDLE_SCHEMA_VERSION;
  readonly classification: "candidate-only";
  readonly foundationOnly: true;
  readonly nativeAuthoringPerformed: false;
  readonly acceptanceEvaluated: false;
  readonly fabricationAuthorized: false;
  readonly qualificationEstablished: false;
  readonly releaseAuthorized: false;
  readonly compilerId: typeof PCB_PLANE_COMPILER_ID;
  readonly originalPrompt: string;
  readonly originalPromptContentIdentity: ContentIdentity;
  readonly executionGuidance: string;
  readonly draft: PcbPlaneReadyCompilation["draft"];
  readonly draftIdentity: ContentIdentity;
  readonly selectionPolicy: PcbPlaneReadyCompilation["selectionPolicy"];
  readonly contract: PcbPlaneReadyCompilation["contract"];
  readonly libraryBinding: PcbPlaneReadyCompilation["libraryBinding"];
  readonly boardFeatureLibrarySources?: PcbPlaneReadyCompilation["boardFeatureLibrarySources"];
  readonly externalPowerBinding?: PcbPlaneReadyCompilation["externalPowerBinding"];
  readonly derivedPowerBinding?: PcbPlaneReadyCompilation["derivedPowerBinding"];
  readonly deepRuleBinding: PcbPlaneReadyCompilation["deepRuleBinding"];
  readonly verificationPlan: PcbPlaneReadyCompilation["verificationPlan"];
  readonly identity: CanonicalIdentity;
}
export interface PcbPlaneCompilationBundleRef {
  readonly schemaVersion: typeof PCB_PLANE_BUNDLE_REF_SCHEMA_VERSION;
  readonly bundleIdentity: CanonicalIdentity;
  readonly contentIdentity: ContentIdentity;
  readonly identity: CanonicalIdentity;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a closed plane bundle object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) throw new Error("Plane bundle has missing or unexpected fields");
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function recompile(draft: unknown, claimedPolicy: unknown, dependencies: PcbPlaneCompilerOptions): PcbPlaneReadyCompilation {
  const policy = normalizePcbPlaneSelectionPolicy(claimedPolicy);
  if (dependencies.deepRuleSelectionOptions !== undefined && !same(policy, normalizePcbPlaneSelectionPolicy(dependencies.deepRuleSelectionOptions))) {
    throw new Error("Plane bundle compiler policy differs from the host pin");
  }
  const compilation = compilePcbPlaneDesignIntentDraft(draft, { ...dependencies, deepRuleSelectionOptions: policy });
  if (compilation.disposition !== "ready") throw new Error(`Plane bundle cannot reproduce a ready compilation: ${compilation.issues.map(issue => issue.message).join(" ")}`);
  return compilation;
}
function build(originalPrompt: unknown, compilation: PcbPlaneReadyCompilation): PcbPlaneCompilationBundle {
  if (typeof originalPrompt !== "string" || originalPrompt.trim().length === 0 || !originalPrompt.isWellFormed()
      || Buffer.byteLength(originalPrompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("Plane bundle original prompt must be nonempty and bounded UTF-8 text");
  const payload = { schemaVersion: PCB_PLANE_BUNDLE_SCHEMA_VERSION, classification: "candidate-only" as const,
    foundationOnly: true as const, nativeAuthoringPerformed: false as const, acceptanceEvaluated: false as const,
    fabricationAuthorized: false as const, qualificationEstablished: false as const, releaseAuthorized: false as const,
    compilerId: PCB_PLANE_COMPILER_ID, originalPrompt, originalPromptContentIdentity: contentIdentity(originalPrompt),
    executionGuidance: guidance + (compilation.contract.interfaceRequirements === undefined ? "" : ` ${PCB_INTERFACE_EXECUTION_GUIDANCE}`)
      + (compilation.contract.interfaceRequirements?.interfaces.some(pair => pair.channel?.feedThrough) ? ` ${PCB_FEED_THROUGH_EXECUTION_GUIDANCE}`
        : compilation.contract.interfaceRequirements?.interfaces.some(pair => pair.channel) ? ` ${PCB_CHANNEL_EXECUTION_GUIDANCE}` : "")
      + (compilation.externalPowerBinding === undefined ? "" : ` ${PCB_EXTERNAL_POWER_EXECUTION_GUIDANCE}`)
      + (compilation.derivedPowerBinding === undefined ? "" : ` ${PCB_DERIVED_POWER_EXECUTION_GUIDANCE}`)
      + (compilation.contract.derivedPowerSources?.some(entry => entry.externalPowerInput !== undefined) ? ` ${PCB_EXTERNAL_DIODE_POWER_EXECUTION_GUIDANCE}` : "")
      + (compilation.contract.boardFeatures === undefined ? "" : " The first host schematic synchronization seeds board-only NPTH mounting features at their immutable contract poses. Preserve their exact approved library IDs, physical holes, UUIDs and native board_only/exclude_from_bom/exclude_from_pos_files dispositions. They are never schematic symbols, electrical terminals or BOM components. Schematic synchronization disables automatic placement; place electrical components explicitly. Require current native hole-clearance DRC and all source-bound feature checks."),
    draft: compilation.draft, draftIdentity: compilation.draftIdentity, selectionPolicy: compilation.selectionPolicy,
    contract: compilation.contract, libraryBinding: compilation.libraryBinding, deepRuleBinding: compilation.deepRuleBinding,
    verificationPlan: compilation.verificationPlan,
    ...(compilation.boardFeatureLibrarySources === undefined ? {} : { boardFeatureLibrarySources: compilation.boardFeatureLibrarySources }),
    ...(compilation.externalPowerBinding === undefined ? {} : { externalPowerBinding: compilation.externalPowerBinding }),
    ...(compilation.derivedPowerBinding === undefined ? {} : { derivedPowerBinding: compilation.derivedPowerBinding }) };
  const bundle = freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, PCB_PLANE_BUNDLE_SCHEMA_VERSION) });
  if (Buffer.byteLength(canonicalJson(bundle) + "\n", "utf8") > PCB_PLANE_BUNDLE_MAX_BYTES) throw new Error("Plane compilation bundle exceeds its aggregate byte bound");
  authenticated.add(bundle);
  return bundle;
}

/** Reproduces all ready artifacts using trusted common libraries/catalog; no CAD calls. */
export function createPcbPlaneCompilationBundle(input: { readonly originalPrompt: string; readonly compilation: PcbPlaneDesignCompilation },
  dependencies: PcbPlaneCompilerOptions): PcbPlaneCompilationBundle {
  const value = record(snapshotPcbPlaneValue(input, PCB_PLANE_BUNDLE_MAX_BYTES));
  keys(value, ["originalPrompt", "compilation"]);
  const claimed = record(value.compilation);
  if (claimed.disposition !== "ready") throw new Error("Only a ready V2 plane compilation can be bundled");
  const compilation = recompile(claimed.draft, claimed.selectionPolicy, dependencies);
  if (!same(claimed, compilation)) throw new Error("Claimed plane compilation differs from independent reconstruction");
  return build(value.originalPrompt, compilation);
}

export function parsePcbPlaneCompilationBundle(input: unknown, dependencies: PcbPlaneCompilerOptions): PcbPlaneCompilationBundle {
  let value: unknown;
  let exactText: string | null = null;
  if (typeof input === "string" || input instanceof Uint8Array) {
    if (typeof input === "string" && !input.isWellFormed()) throw new Error("Plane bundle is not scalar UTF-8 text");
    const raw = capturePortableRawBytes(typeof input === "string" ? Buffer.from(input, "utf8") : input, PCB_PLANE_BUNDLE_MAX_BYTES, false);
    exactText = decodeCapturedPortableUtf8(raw, "Plane compilation bundle");
    value = parseCapturedPortableJsonBytes(raw, { maxBytes: PCB_PLANE_BUNDLE_MAX_BYTES, maxDepth: 64,
      maxNodes: 100_000, maxArrayLength: 1024, maxOwnKeys: 1024, maxStringBytes: 256 * 1024 });
  } else value = snapshotPcbPlaneValue(input, PCB_PLANE_BUNDLE_MAX_BYTES);
  const claimed = record(value);
  if (claimed.schemaVersion !== PCB_PLANE_BUNDLE_SCHEMA_VERSION) throw new Error("Expected the V2 plane compilation bundle family");
  const compilation = recompile(claimed.draft, claimed.selectionPolicy, dependencies);
  const expected = build(claimed.originalPrompt, compilation);
  if (!same(claimed, expected)) throw new Error("Plane bundle identity or child artifacts differ from independent reconstruction");
  if (exactText !== null && exactText !== canonicalJson(expected) + "\n") throw new Error("Plane bundle bytes must be canonical JSON plus one LF");
  return expected;
}

export function serializePcbPlaneCompilationBundle(bundle: PcbPlaneCompilationBundle): Buffer {
  if (!authenticated.has(bundle)) throw new Error("Serialize only an independently created or parsed V2 plane bundle");
  return Buffer.from(canonicalJson(bundle) + "\n", "utf8");
}
export function createPcbPlaneCompilationBundleRef(bundle: PcbPlaneCompilationBundle): PcbPlaneCompilationBundleRef {
  const payload = { schemaVersion: PCB_PLANE_BUNDLE_REF_SCHEMA_VERSION, bundleIdentity: bundle.identity,
    contentIdentity: contentIdentity(serializePcbPlaneCompilationBundle(bundle)) };
  return freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, PCB_PLANE_BUNDLE_REF_SCHEMA_VERSION) });
}
export function parsePcbPlaneCompilationBundleRef(input: unknown): PcbPlaneCompilationBundleRef {
  const value = record(snapshotPcbPlaneValue(input));
  keys(value, ["schemaVersion", "bundleIdentity", "contentIdentity", "identity"]);
  const bundle = record(value.bundleIdentity), content = record(value.contentIdentity);
  keys(bundle, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]);
  keys(content, ["algorithm", "digest", "size"]);
  if (value.schemaVersion !== PCB_PLANE_BUNDLE_REF_SCHEMA_VERSION || bundle.schemaVersion !== PCB_PLANE_BUNDLE_SCHEMA_VERSION
      || bundle.algorithm !== "sha256" || bundle.canonicalizationVersion !== "evleda-c14n-json-v1"
      || typeof bundle.digest !== "string" || !/^[a-f0-9]{64}$/u.test(bundle.digest)
      || content.algorithm !== "sha256" || typeof content.digest !== "string" || !/^[a-f0-9]{64}$/u.test(content.digest)
      || !Number.isSafeInteger(content.size) || (content.size as number) < 1 || (content.size as number) > PCB_PLANE_BUNDLE_MAX_BYTES) throw new Error("Invalid V2 plane bundle reference");
  const { identity, ...payload } = value;
  if (!same(identity, canonicalIdentity(payload, PCB_PLANE_BUNDLE_REF_SCHEMA_VERSION))) throw new Error("Plane bundle reference identity mismatch");
  return freezePcbPlaneArtifact(value) as unknown as PcbPlaneCompilationBundleRef;
}
export function verifyPcbPlaneCompilationBundleRef(ref: unknown, bundle: PcbPlaneCompilationBundle): PcbPlaneCompilationBundleRef {
  const parsed = parsePcbPlaneCompilationBundleRef(ref);
  const expected = createPcbPlaneCompilationBundleRef(bundle);
  if (!same(parsed, expected)) throw new Error("Plane bundle reference does not match the exact authenticated bundle bytes");
  return expected;
}

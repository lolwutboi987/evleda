import path from "node:path";
import { canonicalIdentity, contentIdentity } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { KicadSchematicSourceIdentities, KicadSchematicSvgResult } from "../integrations/kicad-cli.js";
import type { FreshSchematicBodyGraphic } from "./fresh-kicad-parser.js";
import { collectNativeSchematicTextBounds } from "../integrations/schematic-render-clearance.js";

/** Source-audited 10.0.3 SVG command profile; unknown binaries require a new audit. */
export const FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE = Object.freeze({
  schemaVersion: "evleda.kicad-schematic-stroke-native-profile.v1" as const,
  version: "10.0.3",
  executable: Object.freeze({ algorithm: "sha256" as const, digest: "4e1910666330fa8f2321d4e616957dacab218a0d835c343c869a87757481c2f4", size: 2696544 }),
  schematicEngine: Object.freeze({ algorithm: "sha256" as const, digest: "acb3d91c3610f5c951977f06dea7d16e586846ee1c08e94e40d14fbdfd6e3a71", size: 18593120 }),
  nativeObservation: Object.freeze({ algorithm: "sha256" as const, digest: "49395d95fd0799923e7024033e044fbab5b9d5e8e6bbfec7cefb8afdd488c255", size: 210840 }),
  // SCH_RENDER_SETTINGS constructor and SCH_ITEM::GetEffectivePenWidth LIB_SYMBOL branch.
  symbolDefaultWidthMils: 6,
  schematicInternalUnitsPerMm: 10000,
  // JOB_EXPORT_SCH_PLOT_SVG constructor; exact supported CLI argv does not override it.
  minimumPlotPenWidthInternalUnits: 847,
});

export interface FreshSchematicStrokeStyleCapture {
  readonly render: KicadSchematicSvgResult;
  readonly projectSettingsSource: string;
  readonly schematicEngine: Readonly<{ path: string; before: ContentIdentity; after: ContentIdentity }>;
  readonly configuration: Readonly<{
    isolation: "caller-owned-isolated";
    configHome: string;
    treeBefore: CanonicalIdentity;
    treeAfter: CanonicalIdentity;
    applicationConfig: Readonly<{ relativePath: "10.0/eeschema.json"; source: string; before: ContentIdentity; after: ContentIdentity }>;
  }>;
}

const styleBrand: unique symbol = Symbol("source-bound native schematic stroke style");
const issued = new WeakSet<object>();
export interface FreshSchematicStrokeStyleEvidence {
  readonly [styleBrand]: true;
  readonly schemaVersion: "evleda.fresh-schematic-stroke-style.v1";
  readonly identity: CanonicalIdentity;
  readonly invocationIdentity: CanonicalIdentity;
  readonly nativeProfileIdentity: CanonicalIdentity;
  readonly sourceIdentities: KicadSchematicSourceIdentities;
  readonly nativeSvgIdentity: ContentIdentity;
  readonly executableIdentity: ContentIdentity;
  readonly schematicEngineIdentity: ContentIdentity;
  readonly configurationTreeIdentity: CanonicalIdentity;
  readonly applicationConfigIdentity: ContentIdentity;
  readonly applicationDefaultLineThicknessMils: number | null;
  readonly projectDefaultLineThicknessMils: number | null;
  readonly symbolDefaultStrokeWidthMm: number;
  readonly minimumPlotStrokeWidthMm: number;
  readonly semantics: "pinned-cli-library-symbol-default-and-minimum";
  readonly nativeText: ReturnType<typeof collectNativeSchematicTextBounds>;
  /** Separate from library strokes: labels use project line width, ratio and application font. */
  readonly globalLabelPlanning: Readonly<{ supported: boolean; unsupported: readonly string[] }>;
}

const same = (left: ContentIdentity, right: ContentIdentity): boolean => left.algorithm === "sha256" && right.algorithm === "sha256"
  && /^[a-f0-9]{64}$/u.test(left.digest) && left.digest === right.digest && Number.isSafeInteger(left.size) && left.size > 0 && left.size === right.size;
const fail = (message: string): never => { throw new Error(`Unverified schematic stroke style: ${message}`); };
const cloneIdentity = (identity: ContentIdentity): ContentIdentity => Object.freeze({ algorithm: identity.algorithm, digest: identity.digest, size: identity.size });
function configRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function parseConfig(source: string, label: string): Record<string, unknown> {
  if (!source.isWellFormed()) return fail(`${label} is not well-formed UTF-8 text.`);
  return configRecord(parsePortableJsonBytes(Buffer.from(source, "utf8"), { maxBytes: 4 * 1024 * 1024, maxDepth: 64, maxNodes: 200000 }), label);
}
function configuredLineThickness(root: Record<string, unknown>, project: boolean): number | null {
  const settings = project ? (root.schematic === undefined ? {} : configRecord(root.schematic, "schematic settings")) : root;
  const drawing = settings.drawing === undefined ? {} : configRecord(settings.drawing, "drawing settings");
  const value = drawing.default_line_thickness;
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1000 || (!project && !Number.isInteger(value))) {
    return fail("drawing.default_line_thickness is outside the audited numeric settings envelope.");
  }
  return value;
}

function globalLabelPlanningStyle(project: Record<string, unknown>, application: Record<string, unknown>, projectLine: number | null, applicationLine: number | null) {
  const schematic = project.schematic === undefined ? {} : configRecord(project.schematic, "schematic settings");
  const drawing = schematic.drawing === undefined ? {} : configRecord(schematic.drawing, "schematic drawing settings");
  const appearance = application.appearance === undefined ? {} : configRecord(application.appearance, "application appearance");
  const unsupported: string[] = [];
  if (appearance.default_font !== undefined && appearance.default_font !== "KiCad Font") unsupported.push("non-stock-default-font");
  if (drawing.label_size_ratio !== undefined && drawing.label_size_ratio !== 0.375) unsupported.push("non-default-label-size-ratio");
  // Old schematic settings migrate text_offset_ratio into label_size_ratio.
  // Do not interpret a versionless/old override as the modern native default.
  if (drawing.text_offset_ratio !== undefined) {
    const meta = schematic.meta === undefined ? {} : configRecord(schematic.meta, "schematic settings metadata");
    if (typeof meta.version !== "number" || !Number.isInteger(meta.version) || meta.version < 1) unsupported.push("legacy-label-ratio-migration");
  }
  if (projectLine !== null && projectLine !== 6 || projectLine === null && applicationLine !== null && applicationLine !== 6) unsupported.push("non-default-label-plot-stroke");
  return Object.freeze({ supported: unsupported.length === 0, unsupported: Object.freeze(unsupported) });
}

/**
 * Called only by the private bounded renderer producer after it has enforced
 * ordinary-file ownership, isolated environment, preservation and cancellation.
 * Capture declarations are not an alternate public/model authority channel.
 */
export function createFreshSchematicStrokeStyleEvidence(capture: FreshSchematicStrokeStyleCapture, expectedSources: KicadSchematicSourceIdentities): FreshSchematicStrokeStyleEvidence {
  const { render, configuration } = capture;
  const profile = FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE;
  const executable = { algorithm: "sha256" as const, digest: render.executable.sha256, size: render.executable.sizeBytes };
  if (render.classification !== "candidate-validation" || render.releaseAuthorized !== false || render.executable.kind !== "kicad-cli"
      || render.executable.version !== profile.version || !same(executable, profile.executable)) return fail("renderer executable is not the approved native profile.");
  const invocation = render.invocation;
  if (invocation.exitCode !== 0 || invocation.command !== render.executable.path || invocation.executable.sha256 !== executable.digest
      || invocation.executable.sizeBytes !== executable.size || invocation.executable.version !== profile.version) return fail("renderer invocation identity or outcome differs.");
  const args = invocation.args;
  if (args.length !== 9 || args[0] !== "sch" || args[1] !== "export" || args[2] !== "svg" || args[3] !== "--output"
      || args[4] !== render.outputDirectory || args[5] !== "--black-and-white" || args[6] !== "--exclude-drawing-sheet" || args[7] !== "--no-background-color"
      || !path.isAbsolute(args[8]!) || !path.isAbsolute(invocation.cwd)) return fail("SVG argv is outside the audited native command profile.");
  const relativeSchematic = path.relative(invocation.cwd, args[8]!).split(path.sep).join("/");
  if (relativeSchematic === "" || relativeSchematic.startsWith("../") || path.isAbsolute(relativeSchematic)
      || render.sourceHashes[relativeSchematic] !== render.sourceIdentities.schematic.digest) return fail("SVG input path/source binding differs.");
  for (const key of ["schematic", "pcb", "projectSettings"] as const) {
    if (!same(render.sourceIdentities[key], expectedSources[key])) return fail(`stale or different ${key} source identity.`);
  }
  if (!same(contentIdentity(capture.projectSettingsSource), expectedSources.projectSettings)) return fail("raw project settings differ from the rendered project.");
  const svgIdentity = contentIdentity(render.source);
  if (!render.source.isWellFormed() || svgIdentity.size > 8 * 1024 * 1024 || svgIdentity.digest !== render.schematicSvg.sha256 || svgIdentity.size !== render.schematicSvg.sizeBytes) {
    return fail("exact native SVG bytes differ from the captured artifact.");
  }
  if (!same(capture.schematicEngine.before, profile.schematicEngine) || !same(capture.schematicEngine.after, profile.schematicEngine)
      || path.resolve(capture.schematicEngine.path) !== path.resolve(path.dirname(render.executable.path), "_eeschema.dll")) return fail("schematic renderer engine is unpinned, changed, or not the expected sibling.");
  const tree = configuration.treeBefore;
  if (configuration.isolation !== "caller-owned-isolated" || !path.isAbsolute(configuration.configHome)
      || tree.algorithm !== "sha256" || tree.canonicalizationVersion !== "evleda-c14n-json-v1" || !/^[a-f0-9]{64}$/u.test(tree.digest)
      || tree.schemaVersion !== "evleda.kicad-schematic-configuration-tree.v1"
      || configuration.treeAfter.algorithm !== tree.algorithm || configuration.treeAfter.schemaVersion !== tree.schemaVersion
      || configuration.treeAfter.canonicalizationVersion !== tree.canonicalizationVersion || configuration.treeAfter.digest !== tree.digest) return fail("isolated renderer configuration is unbound or changed.");
  const config = configuration.applicationConfig;
  if (config.relativePath !== "10.0/eeschema.json" || !same(config.before, config.after) || !same(contentIdentity(config.source), config.before)) return fail("raw eeschema configuration differs from its before/after identity.");
  const applicationSettings = parseConfig(config.source, "eeschema configuration"), projectSettings = parseConfig(capture.projectSettingsSource, "project configuration");
  const applicationDefaultLineThicknessMils = configuredLineThickness(applicationSettings, false);
  const projectDefaultLineThicknessMils = configuredLineThickness(projectSettings, true);
  const payload = {
    schemaVersion: "evleda.fresh-schematic-stroke-style.v1" as const,
    invocationIdentity: canonicalIdentity(invocation, "evleda.kicad-schematic-svg-invocation.v1"),
    nativeProfileIdentity: canonicalIdentity(profile, profile.schemaVersion),
    sourceIdentities: Object.freeze({ schematic: cloneIdentity(expectedSources.schematic), pcb: cloneIdentity(expectedSources.pcb), projectSettings: cloneIdentity(expectedSources.projectSettings) }),
    nativeSvgIdentity: cloneIdentity(svgIdentity), executableIdentity: cloneIdentity(executable), schematicEngineIdentity: cloneIdentity(capture.schematicEngine.before),
    configurationTreeIdentity: Object.freeze({ ...tree }), applicationConfigIdentity: cloneIdentity(config.before),
    applicationDefaultLineThicknessMils, projectDefaultLineThicknessMils,
    symbolDefaultStrokeWidthMm: profile.symbolDefaultWidthMils * 0.0254,
    minimumPlotStrokeWidthMm: profile.minimumPlotPenWidthInternalUnits / profile.schematicInternalUnitsPerMm,
    semantics: "pinned-cli-library-symbol-default-and-minimum" as const,
    nativeText: collectNativeSchematicTextBounds(render.source),
    globalLabelPlanning: globalLabelPlanningStyle(projectSettings, applicationSettings, projectDefaultLineThicknessMils, applicationDefaultLineThicknessMils),
  };
  const evidence: FreshSchematicStrokeStyleEvidence = Object.freeze({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion), [styleBrand]: true as const });
  issued.add(evidence);
  return evidence;
}

export function assertFreshSchematicStrokeStyleEvidence(evidence: FreshSchematicStrokeStyleEvidence, schematicSourceIdentity: ContentIdentity): void {
  if (!issued.has(evidence) || !same(evidence.sourceIdentities.schematic, schematicSourceIdentity)) return fail("stroke evidence is forged, deserialized, or stale for this schematic.");
}

/** Apply only proven stroke expansion; this cannot repair unsupported geometry or measure fonts. */
export function applyFreshSchematicStrokeStyle(graphics: readonly FreshSchematicBodyGraphic[], evidence: FreshSchematicStrokeStyleEvidence, schematicSourceIdentity: ContentIdentity): readonly FreshSchematicBodyGraphic[] {
  assertFreshSchematicStrokeStyleEvidence(evidence, schematicSourceIdentity);
  return Object.freeze(graphics.map((graphic): FreshSchematicBodyGraphic => {
    if (graphic.centerlineBounds === null || (graphic.unsupportedReason !== null && graphic.unsupportedReason !== "source-default-stroke-width-unbound")) return graphic;
    const width = Math.max(graphic.sourceStrokeWidthMm === null || graphic.sourceStrokeWidthMm === 0 ? evidence.symbolDefaultStrokeWidthMm : graphic.sourceStrokeWidthMm, evidence.minimumPlotStrokeWidthMm);
    const margin = width + 0.001;
    const b = graphic.centerlineBounds;
    const bounds = Object.freeze({ minXmm: b.minXmm - margin, minYmm: b.minYmm - margin, maxXmm: b.maxXmm + margin, maxYmm: b.maxYmm + margin });
    if (Object.values(bounds).some((value) => !Number.isFinite(value) || Math.abs(value) > 2000)) return Object.freeze({ ...graphic, bounds: null, unsupportedReason: "graphic-bounds-out-of-envelope" });
    return Object.freeze({ ...graphic, unsupportedReason: null, bounds });
  }));
}

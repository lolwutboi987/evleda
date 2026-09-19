import { lstat, open, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";
import { verifyPlaneFreshProjectCheckpointReadonly, type PlaneFreshProject } from "../harness/fresh-project.js";
import { serializePcbPlaneCompilationBundle, isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "../harness/pcb-design-plane-bundle.js";
import type { PcbPlaneCompilerOptions } from "../harness/pcb-design-plane-compiler.js";
import { assertPcbLibrarySourcesCurrent } from "../harness/pcb-library-source-binding.js";
import { assertPcbExternalPowerBindingCurrent } from "../harness/pcb-external-power.js";
import { assertPcbDerivedPowerBindingCurrent } from "../harness/pcb-derived-power.js";
import { createInterfaceConstructionBoardSeed } from "../harness/interface-construction-seed.js";
import { parseFreshPcbSource, parseFreshPcbSourceDocument, parseFreshSchematicSourceDocument } from "../harness/fresh-kicad-parser.js";
import { issueFreshPlaneSchematicSeed, type FreshPlaneSchematicSeed } from "../harness/fresh-plane-schematic-seed.js";

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const requireValue = (value: unknown, reason: string): void => { if (!value) throw new Error(`Schematic seed source: ${reason}`); };
const content = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().positive().max(64 * 1024 * 1024) }).strict();
const identity = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u), schemaVersion: z.string().max(128), canonicalizationVersion: z.literal("evleda-c14n-json-v1") }).strict();
export const schematicSeedLineageSchema = z.object({ schemaVersion: z.literal("evleda.plane-unwired-schematic-seed-lineage.v1"),
  sourceProjectId: z.string().uuid(), targetProjectId: z.string().uuid(), sourceBundleIdentity: identity, targetBundleIdentity: identity,
  sourceSnapshotIdentity: identity, sourceCheckpointIdentity: content, sourceSchematicIdentity: content,
  nativeProfileIdentity: content, identity }).strict();
export type SchematicSeedLineage = z.infer<typeof schematicSeedLineageSchema>;
export function parseSchematicSeedLineage(value: unknown): SchematicSeedLineage {
  const parsed = schematicSeedLineageSchema.parse(value), { identity: claimed, ...payload } = parsed;
  requireValue(equal(claimed, canonicalIdentity(payload, parsed.schemaVersion)), "lineage identity does not reproduce");
  return Object.freeze(parsed);
}
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs, s.mode, s.nlink].map(String).join(":");
interface Captured { readonly path: string; readonly bytes: Buffer; readonly identity: ContentIdentity; readonly physical: string }
async function capture(file: string, limit: number): Promise<Captured> {
  requireValue(path.isAbsolute(file) && path.resolve(file) === file, "source path is not canonical");
  const directories: { path: string; physical: string }[] = [];
  for (let directory = path.dirname(file);;) {
    const state = await lstat(directory, { bigint: true });
    requireValue(state.isDirectory() && !state.isSymbolicLink() && samePath(await realpath(directory), directory), "source ancestry is a link or alias");
    directories.push({ path: directory, physical: `${state.dev}:${state.ino}` });
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  const before = await lstat(file, { bigint: true });
  requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(limit)
    && samePath(await realpath(file), file), "source must be a bounded ordinary unshared file");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat({ bigint: true }); requireValue(stamp(before) === stamp(opened), "source changed while opening");
    const buffer = Buffer.alloc(Math.min(limit, Number(opened.size)) + 1); let used = 0;
    while (used < buffer.length) { const result = await handle.read(buffer, used, buffer.length - used, used); if (!result.bytesRead) break; used += result.bytesRead; }
    const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    requireValue(BigInt(used) === opened.size && used <= limit && stamp(after) === stamp(opened) && stamp(current) === stamp(opened)
      && current.isFile() && !current.isSymbolicLink() && current.nlink === 1n && samePath(await realpath(file), file), "source changed during capture");
    for (const directory of directories) { const now = await lstat(directory.path, { bigint: true });
      requireValue(now.isDirectory() && !now.isSymbolicLink() && `${now.dev}:${now.ino}` === directory.physical
        && samePath(await realpath(directory.path), directory.path), "source ancestry changed during capture"); }
    const bytes = buffer.subarray(0, used);
    return Object.freeze({ path: file, bytes, identity: contentIdentity(bytes), physical: stamp(current) });
  } finally { await handle.close(); }
}
const sourceText = (bytes: Buffer): string => {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  requireValue(Buffer.from(source, "utf8").equals(bytes), "source bytes must round-trip strict UTF-8 without replacement");
  return source;
};
interface SourceContext {
  readonly project: PlaneFreshProject; readonly bundle: PcbPlaneCompilationBundle; readonly profile: KicadMcpPinnedFileInput;
  readonly dependencies: PcbPlaneCompilerOptions; readonly symbolRoot: string;
}
export type ClosedPlaneSeedSourceContext = SourceContext;
function currentLibraries(context: SourceContext) {
  assertPcbLibrarySourcesCurrent(context.bundle.libraryBinding, context.dependencies.libraryResolver);
  if (context.bundle.externalPowerBinding) assertPcbExternalPowerBindingCurrent(context.bundle.externalPowerBinding, context.dependencies.libraryResolver);
  if (context.bundle.derivedPowerBinding) assertPcbDerivedPowerBindingCurrent(context.bundle.derivedPowerBinding, context.bundle.libraryBinding, context.dependencies.libraryResolver);
}
async function snapshot(context: SourceContext) {
  const { project, bundle, profile } = context;
  currentLibraries(context);
  const files: Record<string, Captured> = {};
  const names = { profile: profile.path, marker: project.markerPath, checkpoint: project.checkpointPath,
    bundle: path.join(project.outputPath, "toolbox-design-bundle.json"), report: path.join(project.outputPath, "pcb-agent-report.json"),
    sch: project.schematicPath, pcb: project.pcbPath, pro: path.join(project.projectPath, `${project.name}.kicad_pro`),
    dru: project.rulesPath, sym: path.join(project.projectPath, "sym-lib-table"), fp: path.join(project.projectPath, "fp-lib-table") };
  for (const [key, file] of Object.entries(names)) files[key] = await capture(file, key === "bundle" ? 8 * 1024 * 1024 : key === "report" ? 16 * 1024 * 1024 : 2 * 1024 * 1024);
  requireValue(equal(files.profile!.identity, profile.contentIdentity), "native source profile bytes changed");
  requireValue(files.bundle!.bytes.equals(Buffer.from(serializePcbPlaneCompilationBundle(bundle))), "source bundle bytes differ from the bound native project");
  const verified = await verifyPlaneFreshProjectCheckpointReadonly(project, bundle);
  requireValue(verified.reportSha256 === files.report!.identity.digest, "report is not the exact closed checkpoint report");
  for (const [key, previous] of Object.entries(files)) {
    const after = await capture(previous.path, Math.max(previous.bytes.length, 1));
    requireValue(equal(previous.identity, after.identity) && previous.physical === after.physical, `source ${key} changed during qualification`);
  }
  currentLibraries(context);
  const sourceIdentity = canonicalIdentity({ files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key,
    { path: value.path, identity: value.identity, physical: value.physical }])), projectIdentity: verified.projectIdentity }, "evleda.closed-plane-seed-source.v1");
  return { files, verified, identity: sourceIdentity };
}
/** Shared host-only capture mechanics. This snapshot alone is not close/seed authority. */
export const captureClosedPlaneSeedSnapshot = snapshot;
export interface ClosedPlaneSchematicSeedSource { readonly kind: "same-connection-closed-plane-source" }
const closed = new WeakMap<object, { context: SourceContext; identity: CanonicalIdentity }>();
/** Called by the genuine plane binding only after successful native close/checkpoint,
 * while the workspace still holds that source project's lease.
 */
export async function captureClosedPlaneSchematicSeedSource(input: SourceContext): Promise<ClosedPlaneSchematicSeedSource | undefined> {
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(input.bundle), "closed source bundle is unauthenticated");
  // Ineligible ordinary closes stay ordinary closes. No seed authority is
  // retained for materialized boards, connected/empty or oversized schematics.
  const [sch, pcb] = await Promise.all([lstat(input.project.schematicPath), lstat(input.project.pcbPath)]);
  if (sch.size > 2 * 1024 * 1024 || pcb.size > 2 * 1024 * 1024) return undefined;
  const board = await capture(input.project.pcbPath, 2 * 1024 * 1024);
  if (!equal(board.identity, contentIdentity(createInterfaceConstructionBoardSeed(input.bundle)))) return undefined;
  const schematic = await capture(input.project.schematicPath, 2 * 1024 * 1024), root = parseFreshSchematicSourceDocument(sourceText(schematic.bytes));
  const allowed = new Set(["version", "generator", "generator_version", "uuid", "paper", "title_block", "lib_symbols", "symbol", "sheet_instances", "embedded_fonts"]);
  if (!root.children.some(node => node.name === "symbol") || root.children.some(node => !allowed.has(node.name))) return undefined;
  const context = Object.freeze({ ...input, profile: Object.freeze(structuredClone(input.profile)) });
  const captured = await snapshot(context);
  const receipt: ClosedPlaneSchematicSeedSource = Object.freeze({ kind: "same-connection-closed-plane-source" });
  closed.set(receipt, { context, identity: captured.identity }); return receipt;
}
export async function assertClosedPlaneSchematicSeedSourceCurrent(receipt: ClosedPlaneSchematicSeedSource): Promise<void> {
  const state = closed.get(receipt); requireValue(state !== undefined, "close receipt is not from this workspace connection");
  requireValue(equal((await snapshot(state!.context)).identity, state!.identity), "source changed after its successful close");
}
export async function qualifyClosedPlaneSchematicSeed(input: {
  receipt: ClosedPlaneSchematicSeedSource; sourceProjectId: string; sourceOutputDir: string; targetProjectId: string; name: string;
  targetBundle: PcbPlaneCompilationBundle; profile: KicadMcpPinnedFileInput; assertLeaseCurrent: () => Promise<void>;
}): Promise<Readonly<{ seed: FreshPlaneSchematicSeed; lineage: SchematicSeedLineage; assertCurrent: () => Promise<void> }>> {
  const state = closed.get(input.receipt); requireValue(state !== undefined, "source has no successful close in this connection");
  const context = state!.context, source = context.bundle, target = input.targetBundle;
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(target) && input.sourceProjectId !== input.targetProjectId
    && context.project.outputPath === input.sourceOutputDir && context.project.name === input.name
    && equal(context.profile, input.profile), "source name, allocation, V2 family or native profile differs");
  // A new, unmaterialized PCB may receive new implementation constraints. Keep
  // this explicit path list closed: no electrical or physical source is copied
  // under a changed circuit, stackup, feature definition, plane settings or interface.
  const net = ({ netClassId: _class, ...rest }: PcbPlaneCompilationBundle["contract"]["nets"][number]) => rest;
  const scope = ({ board: { widthMm: _width, heightMm: _height, ...board }, ...rest }: PcbPlaneCompilationBundle["draft"]["scope"]) => ({ ...rest, board });
  const feature = ({ pose: { xMm: _x, yMm: _y, rotationDeg: _rotation, ...pose }, ...rest }:
    NonNullable<PcbPlaneCompilationBundle["draft"]["boardFeatures"]>[number]) => ({ ...rest, pose });
  const plane = ({ boundary, ...rest }: PcbPlaneCompilationBundle["draft"]["planes"][number]) => ({ ...rest,
    boundary: boundary === null ? null : (({ minXmm: _minX, maxXmm: _maxX, minYmm: _minY, maxYmm: _maxY, ...shape }) => shape)(boundary) });
  const contract = ({ identity: _identity, placementConstraints: _placement, netClasses: _classes,
    routingConstraints: _routing, nativeRuleMode: _mode, scope: boardScope, boardFeatures, nets, planes, ...rest }: PcbPlaneCompilationBundle["contract"]) => ({ ...rest,
      scope: scope(boardScope), ...(boardFeatures === undefined ? {} : { boardFeatures: boardFeatures.map(feature) }), nets: nets.map(net), planes: planes.map(plane) });
  const draft = ({ placementConstraints: _placement, netClasses: _classes, routingConstraints: _routing,
    nativeRuleMode: _mode, scope: boardScope, boardFeatures, nets, planes, ...rest }: PcbPlaneCompilationBundle["draft"]) => ({ ...rest,
      scope: scope(boardScope), ...(boardFeatures === undefined ? {} : { boardFeatures: boardFeatures === null ? null : boardFeatures.map(feature) }),
      nets: nets?.map(({ netClassId: _class, ...electrical }) => electrical), planes: planes.map(plane) });
  const libraries = ({ identity: _identity, contractIdentity: _contract, ...rest }: PcbPlaneCompilationBundle["libraryBinding"]) => rest;
  requireValue(equal(contract(source.contract), contract(target.contract)) && equal(draft(source.draft), draft(target.draft))
    && equal(libraries(source.libraryBinding), libraries(target.libraryBinding)) && equal(source.selectionPolicy, target.selectionPolicy),
  "only PCB width/height, component placement, board-feature pose coordinates/rotation, plane rectangle coordinates, net-class assignments/settings, routing constraints, native numeric mode and original-prompt metadata may differ");
  const assertCurrent = async () => { await input.assertLeaseCurrent(); await assertClosedPlaneSchematicSeedSourceCurrent(input.receipt); await input.assertLeaseCurrent(); };
  await assertCurrent();
  const current = await snapshot(context);
  requireValue(equal(current.identity, state!.identity), "source changed during seed selection");
  const pcb = current.files.pcb!, baseline = contentIdentity(createInterfaceConstructionBoardSeed(source));
  requireValue(equal(pcb.identity, baseline) && current.verified.baselinePcbSha256 === baseline.digest
    && current.verified.checkpointPcbSha256 === baseline.digest, "source PCB is not its authenticated unmaterialized baseline");
  const board = parseFreshPcbSource(sourceText(pcb.bytes)), boardRoot = parseFreshPcbSourceDocument(sourceText(pcb.bytes));
  requireValue(!board.footprints.length && !board.segments.length && !board.vias.length && !boardRoot.children.some(node => node.name === "zone"), "source PCB contains authored objects");
  const schematic = sourceText(current.files.sch!.bytes), tree = parseFreshSchematicSourceDocument(schematic);
  const needed = new Set(tree.children.filter(node => node.name === "symbol").map(node => node.children.find(child => child.name === "lib_id")?.values[0]?.value));
  const librarySources = new Map<string, { source: string; identity: ContentIdentity }>(), captures = new Map<string, Captured>();
  let aggregate = 0;
  for (const id of needed) {
    requireValue(typeof id === "string", "placed symbol has no exact library ID");
    const pin = source.libraryBinding.sourceSelection?.records.find(record => record.kind === "symbol" && record.libraryId === id);
    requireValue(pin !== undefined, "placed symbol lacks a current source selection pin");
    const filename = path.resolve(pin!.approvedPackage?.tableUri ?? path.join(context.symbolRoot, `${id!.split(":")[0]}.kicad_sym`));
    let bytes = captures.get(filename);
    if (bytes === undefined) { aggregate += pin!.sourceIdentity.size; requireValue(aggregate <= 64 * 1024 * 1024, "selected symbol sources exceed aggregate qualification bounds");
      bytes = await capture(filename, 24 * 1024 * 1024); captures.set(filename, bytes); }
    requireValue(equal(bytes.identity, pin!.sourceIdentity), "approved symbol bytes differ from their source pin");
    librarySources.set(id!, { source: sourceText(bytes.bytes), identity: bytes.identity });
  }
  await assertCurrent();
  for (const previous of captures.values()) { const after = await capture(previous.path, previous.bytes.length);
    requireValue(equal(previous.identity, after.identity) && previous.physical === after.physical, "symbol source changed during qualification"); }
  const seed = issueFreshPlaneSchematicSeed({ source: schematic, name: input.name, bundle: target, profile: input.profile, librarySources, assertCurrent });
  const payload = { schemaVersion: "evleda.plane-unwired-schematic-seed-lineage.v1" as const,
    sourceProjectId: input.sourceProjectId, targetProjectId: input.targetProjectId, sourceBundleIdentity: source.identity, targetBundleIdentity: target.identity,
    sourceSnapshotIdentity: current.identity, sourceCheckpointIdentity: current.files.checkpoint!.identity,
    sourceSchematicIdentity: current.files.sch!.identity, nativeProfileIdentity: current.files.profile!.identity };
  const lineage = parseSchematicSeedLineage({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  return Object.freeze({ seed, lineage, assertCurrent });
}

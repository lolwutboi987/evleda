import { createHash } from "node:crypto";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { FreshProject, FreshProjectOpenPreparedSourceAuthority } from "./fresh-project.js";
import { bindKicadPhysicalFootprintLibraries } from "../integrations/kicad-native-pad-observation.js";
import { parseFreshPcbSource, parseFreshPcbSourceDocument } from "./fresh-kicad-parser.js";
import { planFreshFootprintPlacement } from "./fresh-footprint-placement.js";
import { assertPcbBoardFeatureInventory, assertPcbBoardFeatureSourceBytes } from "./pcb-board-features.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import type { PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";
import { assertPcbLibrarySourcesCurrent } from "./pcb-library-source-binding.js";
import { createInterfaceConstructionBoardSeed } from "./interface-construction-seed.js";
import { freshBoardSerializationsEqual } from "./fresh-board-serialization.js";

const requireValue = (value: unknown, message: string): void => { if (!value) throw new Error(`Board features: ${message}`); };
const seededIdentities = new WeakMap<object, ReadonlyMap<string, readonly (string | null)[]>>();
/** Strict physical-feature verification; the preparation lifecycle owns the sole pre-sync exception. */
export function verifyFreshBoardFeatures(bundle: PcbPlaneCompilationBundle, source: string, resolver?: PcbReadOnlyLibraryResolver): void {
  if (bundle.contract.boardFeatures === undefined) return;
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(bundle), "authenticated V2 bundle required");
  if (resolver !== undefined) assertPcbLibrarySourcesCurrent(bundle.libraryBinding, resolver);
  const board = parseFreshPcbSource(source);
  assertPcbBoardFeatureInventory(bundle.contract, board, source, false);
  let identities = seededIdentities.get(bundle);
  if (identities === undefined) {
    const seed = parseFreshPcbSource(seedFreshBoardFeatures(bundle, "(kicad_pcb)"));
    identities = new Map(seed.footprints.map(fp => [fp.reference, [fp.id, ...fp.pads.map(pad => pad.physical.id)]]));
    seededIdentities.set(bundle, identities);
  }
  for (const feature of bundle.contract.boardFeatures) {
    const fp = board.footprints.find(fp => fp.reference === feature.reference)!;
    const ids = [fp.id, ...fp.pads.map(pad => pad.physical.id)], expected = identities.get(feature.reference)!;
    requireValue(ids.length === expected.length && ids.every((id, index) => id === expected[index]), `${feature.reference} immutable footprint or bore UUID differs from its source-bound seed`);
  }
  if (resolver !== undefined) {
    requireValue(resolver.inspectFootprint !== undefined, "approved footprint inspection required");
    const pins = bundle.contract.boardFeatures.map(feature => {
      const pin = bundle.libraryBinding.sourceSelection?.records.find(record => record.kind === "footprint" && record.libraryId === feature.footprintLibId);
      if (pin === undefined) throw new Error("Board feature source pin is missing.");
      return { reference: feature.reference, libraryId: feature.footprintLibId, sourceIdentity: pin.sourceIdentity };
    });
    bindKicadPhysicalFootprintLibraries(board, { pcbPath: "C:\\host-owned-board.kicad_pcb", pcbSource: source, requestedPrimitiveIds: [],
      enabledCopperLayers: bundle.contract.scope.board.copperLayers, scopeIdentity: bundle.identity,
      physicalFootprintResolver: { inspectFootprint: id => resolver.inspectFootprint!(id) }, physicalFootprints: pins });
    assertPcbLibrarySourcesCurrent(bundle.libraryBinding, resolver);
  }
}

/** One in-process lifecycle bit. The existing checkpoint's hash-verified PCB
 * supplies its initial value on resume; no new artifact or checkpoint family. */
export interface FreshBoardFeatureState {
  verify(source: string, resolver?: PcbReadOnlyLibraryResolver): void;
  commitSavedSource(source: string, resolver?: PcbReadOnlyLibraryResolver): void;
}
const featureStates = new WeakMap<object, Readonly<{ bundle: string; project: string }>>();
/** Before the first sync, the native outline tool may add its one rectangle.
 * Remove only that exact contract-sized form for comparison with the prepared
 * constructor. All settings and other source forms remain bound; no shape-only
 * empty-board exception or feature repair is permitted. */
function isPreparedFeatureSource(bundle: PcbPlaneCompilationBundle, preparedSource: string, source: string): boolean {
  if (freshBoardSerializationsEqual(source, preparedSource)) return true;
  const rectangles = parseFreshPcbSourceDocument(source).children.filter(node => node.name === "gr_rect");
  if (rectangles.length !== 1) return false;
  const rectangle = rectangles[0]!, ids = rectangle.children.filter(node => node.name === "uuid");
  const id = ids[0]?.values[0]?.value;
  if (ids.length !== 1 || ids[0]!.values.length !== 1 || ids[0]!.children.length !== 0
      || id === undefined || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) return false;
  const board = bundle.contract.scope.board;
  const expected = `(gr_rect (start 0 0) (end ${board.widthMm} ${board.heightMm})
    (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "${id}"))`;
  return freshBoardSerializationsEqual(`(kicad_pcb ${source.slice(rectangle.start, rectangle.end)})`, `(kicad_pcb ${expected})`)
    && freshBoardSerializationsEqual(source.slice(0, rectangle.start) + source.slice(rectangle.end), preparedSource);
}
export function assertFreshBoardFeatureState(state: FreshBoardFeatureState | undefined, bundle: PcbPlaneCompilationBundle, project: FreshProject | undefined): void {
  const bound = state === undefined ? undefined : featureStates.get(state);
  if (bundle.contract.boardFeatures !== undefined) requireValue(bound !== undefined && bound.bundle === bundle.identity.digest
      && project !== undefined && bound.project === canonicalJson(project.projectIdentity),
    "feature preparation lifecycle authority is missing or belongs to another bundle");
}
/** Call only after preparation or resume has authenticated the actual prepared
 * authority and latest checkpoint. The canonical constructor independently
 * prevents an arbitrary empty board becoming a new prepared baseline. */
export function createFreshBoardFeatureState(bundle: PcbPlaneCompilationBundle, prepared: FreshProjectOpenPreparedSourceAuthority,
  checkpointPcbSha256 = prepared.pcb.digest, checkpointPcbSource?: string): FreshBoardFeatureState | undefined {
  if (bundle.contract.boardFeatures === undefined) return undefined;
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(bundle), "authenticated V2 bundle required");
  const preparedPcb = prepared.pcb;
  const preparedSource = createInterfaceConstructionBoardSeed(bundle), expected = contentIdentity(preparedSource);
  requireValue(preparedPcb.algorithm === expected.algorithm && preparedPcb.digest === expected.digest && preparedPcb.size === expected.size,
    "prepared PCB identity differs from its canonical constructor");
  requireValue(/^[a-f0-9]{64}$/u.test(checkpointPcbSha256), "invalid authenticated checkpoint PCB identity");
  if (checkpointPcbSource !== undefined) requireValue(contentIdentity(checkpointPcbSource).digest === checkpointPcbSha256,
    "PCB source differs from the authenticated checkpoint identity");
  let materialized = checkpointPcbSha256 !== preparedPcb.digest
    && (checkpointPcbSource === undefined || !isPreparedFeatureSource(bundle, preparedSource, checkpointPcbSource));
  const state: FreshBoardFeatureState = Object.freeze({
    verify(source: string, resolver?: PcbReadOnlyLibraryResolver) {
      if (resolver !== undefined) assertPcbLibrarySourcesCurrent(bundle.libraryBinding, resolver);
      if (!materialized && isPreparedFeatureSource(bundle, preparedSource, source)) return;
      verifyFreshBoardFeatures(bundle, source, resolver);
    },
    commitSavedSource(source: string, resolver?: PcbReadOnlyLibraryResolver) {
      // Staging and failed compounds never consume the exception. Only the
      // successful mandatory save/readback path calls this monotonic commit.
      verifyFreshBoardFeatures(bundle, source, resolver);
      materialized = true;
    },
  });
  featureStates.set(state, { bundle: bundle.identity.digest, project: canonicalJson(prepared.projectIdentity) });
  return state;
}

/** Host-only pre-sync source plan; DOC9 performs native serialization and reload inside the existing rollback compound. */
export function seedFreshBoardFeatures(bundle: PcbPlaneCompilationBundle, source: string): string {
  if (bundle.contract.boardFeatures === undefined) return source;
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(bundle), "authenticated V2 source authority required");
  const current = parseFreshPcbSource(source);
  if (current.footprints.length !== 0) { verifyFreshBoardFeatures(bundle, source); return source; }
  requireValue(current.segments.length === 0 && current.vias.length === 0, "only a fresh empty board can receive its feature seed");
  let result = source;
  for (const feature of bundle.contract.boardFeatures) {
    const library = bundle.boardFeatureLibrarySources?.find(record => record.libraryId === feature.footprintLibId);
    if (library === undefined) throw new Error("Missing compiled exact board-feature source.");
    assertPcbBoardFeatureSourceBytes(library);
    const wrapped = `(kicad_pcb ${library.source})`, root = parseFreshPcbSourceDocument(wrapped), fp = root.children[0]!;
    const changes: { start: number; end: number; text: string }[] = [];
    const replace = (node: { start: number; end: number }, text: string) => changes.push({ start: node.start, end: node.end, text });
    let ordinal = 0;
    const uuid = () => { const hex = createHash("sha256").update(`${bundle.identity.digest}:${feature.reference}:${ordinal++}`).digest("hex");
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`; };
    replace(fp.values[0]!, JSON.stringify(feature.footprintLibId));
    const removed = new Set(["version", "generator", "generator_version", "uuid", "tstamp", "at", "attr", "path", "sheetname", "sheetfile"]);
    for (const node of fp.children.filter(node => removed.has(node.name))) replace(node, "");
    const drawables = new Set(["property", "pad", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve"]);
    for (const child of fp.children.filter(node => !removed.has(node.name))) {
      const ids = child.children.filter(node => node.name === "uuid" || node.name === "tstamp");
      requireValue(ids.length <= 1, "duplicate source child identities");
      if (drawables.has(child.name)) {
        if (ids.length) replace(ids[0]!, `(uuid "${uuid()}")`);
        else changes.push({ start: child.end - 1, end: child.end - 1, text: ` (uuid "${uuid()}")` });
      }
      if (child.name === "property" && ["Reference", "Value"].includes(child.values[0]?.value ?? "")) {
        requireValue(child.values.length === 2, "malformed source property");
        replace(child.values[1]!, JSON.stringify(child.values[0]!.value === "Reference" ? feature.reference : feature.value));
      }
    }
    for (const field of ["Reference", "Value"]) requireValue(fp.children.filter(node => node.name === "property" && node.values[0]?.value === field).length === 1, `source requires exactly one ${field} property`);
    changes.push({ start: fp.end - 1, end: fp.end - 1,
      text: `\n (at 0 0) (uuid "${uuid()}") (attr board_only exclude_from_pos_files exclude_from_bom)\n` });
    changes.sort((a, b) => b.start - a.start);
    let seeded = wrapped;
    for (const edit of changes) seeded = seeded.slice(0, edit.start) + edit.text + seeded.slice(edit.end);
    seeded = planFreshFootprintPlacement(seeded, { reference: feature.reference, ...feature.pose }).source;
    const node = parseFreshPcbSourceDocument(seeded).children[0]!;
    const at = parseFreshPcbSourceDocument(result).end - 1;
    result = result.slice(0, at) + `\n${seeded.slice(node.start, node.end)}\n` + result.slice(at);
  }
  assertPcbBoardFeatureInventory(bundle.contract, parseFreshPcbSource(result), result, false);
  return result;
}

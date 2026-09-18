import { z } from "zod";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";
import { isSupportedSavedMechanicalHole } from "../integrations/kicad-native-pad-observation.js";
import { parseFreshPcbSource, parseFreshPcbSourceDocument, type FreshKicadSourceNode as Node, type FreshParsedPcb } from "./fresh-kicad-parser.js";

const dimension = (minimum: number, maximum: number) => z.number().finite().min(minimum).max(maximum)
  .refine(value => !Object.is(value, -0) && /^\d+(?:\.\d{1,6})?$/u.test(String(value)), "Use exact nonnegative integer-nanometre dimensions");
export const pcbBoardFeatureSchema = z.object({
  kind: z.literal("npth_mounting_hole"), reference: z.string().regex(/^H[1-9][0-9]{0,3}$/u),
  footprintLibId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}:[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}$/u),
  value: z.string().min(1).max(192).refine(value => value.isWellFormed() && !/[\x00-\x1f\x7f]/u.test(value)),
  pose: z.object({ side: z.literal("front"), xMm: dimension(0, 500), yMm: dimension(0, 500),
    rotationDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]) }).strict(),
  boreDiameterMm: dimension(0.2, 20), minimumHoleToCopperMm: dimension(0.05, 10), minimumHoleToEdgeMm: dimension(0, 10),
}).strict();
export const pcbBoardFeaturesSchema = z.array(pcbBoardFeatureSchema).min(1).max(16);
export type PcbBoardFeature = z.infer<typeof pcbBoardFeatureSchema>;
export interface PcbBoardFeatureLibrarySource { readonly libraryId: string; readonly source: string; readonly sourceIdentity: ContentIdentity }
export interface PcbBoardFeatureContract {
  readonly boardFeatures?: readonly PcbBoardFeature[] | undefined;
  readonly components: readonly Readonly<{ reference: string; footprintLibId: string | null }>[];
}
const requireValue = (condition: unknown, message: string): void => { if (!condition) throw new Error(`Board features: ${message}`); };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const quote = (value: string) => JSON.stringify(value);
const UUID = "11111111-1111-4111-8111-111111111111";
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function exactNm(text: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text);
  if (text.length > 128 || match === null) throw new Error("Board feature has unsupported exact source geometry.");
  const power = 6 + Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(power) || Math.abs(power) > 100) throw new Error("Board feature source exponent exceeds its bound.");
  let value = BigInt(match[2]! + (match[3] ?? ""));
  if (power >= 0) value *= 10n ** BigInt(power);
  else { const divisor = 10n ** BigInt(-power); if (value % divisor !== 0n) throw new Error("Board feature source geometry is not exact integer nanometres."); value /= divisor; }
  return match[1] === "-" ? -value : value;
}
export interface MechanicalSourceNode { readonly name: string; readonly values: readonly { readonly value: string; readonly quoted: boolean }[]; readonly children: readonly MechanicalSourceNode[] }
export const mechanicalSourceNodeText = (node: MechanicalSourceNode): string => `(${node.name}${node.values.map(atom => ` ${atom.quoted ? quote(atom.value) : atom.value}`).join("")}${node.children.map(child => ` ${mechanicalSourceNodeText(child)}`).join("")})`;
/** The feature branch cannot smuggle copper drawings, zones, or unknown physical children alongside its single bore. */
function assertMechanicalSourceScope(footprint: Node): void {
  const fields = new Set(["version", "generator", "generator_version", "layer", "at", "uuid", "tstamp", "descr", "tags", "property", "attr",
    "duplicate_pad_numbers_are_jumpers", "fp_circle", "fp_line", "fp_rect", "fp_arc", "fp_poly", "fp_curve", "fp_text", "pad", "embedded_fonts", "model"]);
  requireValue(footprint.children.every(child => fields.has(child.name)), "unsupported mechanical footprint source child");
  const inspectLayer = (node: Node): void => {
    if (node.name === "layer" || node.name === "layers") requireValue(node.values.every(atom => !/\.Cu$|\*\.Cu|F&B\.Cu/u.test(atom.value)), "mechanical feature has conductive graphic/text geometry");
    node.children.forEach(inspectLayer);
  };
  for (const child of footprint.children) if (!["pad", "layer", "model"].includes(child.name)) inspectLayer(child);
}

/** Zero terminals are admitted only for a single centered circular NPTH, through the existing exact saved-pad guard. */
export function isSupportedMechanicalFootprintPads(pads: readonly { readonly definition: MechanicalSourceNode }[]): boolean {
  if (pads.length !== 1) return false;
  try {
    const original = pads[0]!.definition;
    const node = { ...original, children: [...original.children.filter(child => child.name !== "uuid" && child.name !== "tstamp"),
      { name: "uuid", values: [{ value: UUID, quoted: true }], children: [] }] };
    const board = parseFreshPcbSource(`(kicad_pcb (footprint "MountingHole:guard" (layer "F.Cu") (at 0 0) (property "Reference" "H1") ${mechanicalSourceNodeText(node)}))`);
    const pad = board.footprints[0]!.pads[0]!;
    return isSupportedSavedMechanicalHole(pad) && pad.physical.shape === "circle"
      && pad.physical.relativeAt.x === 0 && pad.physical.relativeAt.y === 0;
  } catch { return false; }
}

export function validatePcbBoardFeatureRelationships(document: { readonly boardFeatures?: readonly PcbBoardFeature[] | null | undefined;
  readonly components: readonly { readonly reference: string }[];
  readonly scope: { readonly board: { readonly widthMm: number | null; readonly heightMm: number | null } } }, context: z.RefinementCtx): void {
  const features = document.boardFeatures ?? [], refs = new Set(document.components.map(component => component.reference));
  for (const [index, feature] of features.entries()) {
    const issue = (message: string) => context.addIssue({ code: "custom", path: ["boardFeatures", index], message });
    if (refs.has(feature.reference)) issue("Board feature references must be unique and separate from electrical components");
    refs.add(feature.reference);
    const radius = feature.boreDiameterMm / 2 + feature.minimumHoleToEdgeMm, { xMm: x, yMm: y } = feature.pose;
    if (x < radius || y < radius || document.scope.board.widthMm !== null && x + radius > document.scope.board.widthMm
        || document.scope.board.heightMm !== null && y + radius > document.scope.board.heightMm) issue("Hole violates its exact board edge clearance");
    for (const other of features.slice(0, index)) if (Math.hypot(x - other.pose.xMm, y - other.pose.yMm) <= (feature.boreDiameterMm + other.boreDiameterMm) / 2) issue("Board feature bores must not intersect");
  }
}

/** Raw inventory remains intact. Callers choose whether a partially authored electrical board is allowed. */
export function assertPcbBoardFeatureInventory(contract: PcbBoardFeatureContract, board: FreshParsedPcb, source?: string, completeElectrical = true): void {
  const features = contract.boardFeatures ?? [], expected = [...contract.components, ...features];
  requireValue(new Set(board.footprints.map(fp => fp.reference)).size === board.footprints.length, "duplicate footprint reference");
  requireValue(board.footprints.every(fp => expected.some(entry => entry.reference === fp.reference)), "unknown extra physical footprint");
  if (completeElectrical) requireValue(board.footprints.length === expected.length, "complete physical footprint inventory differs from contract");
  const nodes = source === undefined ? undefined : parseFreshPcbSourceDocument(source).children.filter(node => node.name === "footprint");
  for (const feature of features) {
    const fp = board.footprints.find(fp => fp.reference === feature.reference);
    requireValue(fp !== undefined, `missing board feature ${feature.reference}`);
    if (fp === undefined) continue;
    requireValue(fp.libraryId === feature.footprintLibId && fp.value === feature.value && fp.layer === "F.Cu"
      && fp.at.x === feature.pose.xMm && fp.at.y === feature.pose.yMm && ((fp.rotationDeg % 360) + 360) % 360 === feature.pose.rotationDeg,
    `${feature.reference} exact library, value or immutable pose differs`);
    const allIds = board.footprints.flatMap(footprint => [footprint.id, ...footprint.pads.map(pad => pad.physical.id)]);
    requireValue(fp.id !== null && UUID_PATTERN.test(fp.id) && allIds.filter(id => id === fp.id).length === 1
      && fp.pads.length === 1 && fp.pads.every(pad => allIds.filter(id => id === pad.physical.id).length === 1 && isSupportedSavedMechanicalHole(pad)
      && pad.physical.shape === "circle" && pad.physical.relativeAt.x === 0 && pad.physical.relativeAt.y === 0
      && pad.physical.drill?.sizeMm.x === feature.boreDiameterMm), `${feature.reference} exact NPTH bore or disposition differs`);
    if (nodes !== undefined) {
      const node = nodes.find(node => node.children.some(child => child.name === "property" && child.values[0]?.value === "Reference" && child.values[1]?.value === feature.reference))!;
      assertMechanicalSourceScope(node);
      const attrs = node.children.filter(child => child.name === "attr");
      const at = node.children.filter(child => child.name === "at");
      requireValue(at.length === 1 && at[0]!.children.length === 0 && [2,3].includes(at[0]!.values.length)
        && at[0]!.values.every(atom => !atom.quoted), `${feature.reference} malformed exact pose`);
      requireValue(exactNm(at[0]!.values[0]!.value) === exactNm(String(feature.pose.xMm))
        && exactNm(at[0]!.values[1]!.value) === exactNm(String(feature.pose.yMm))
        && ((exactNm(at[0]!.values[2]?.value ?? "0") % 360_000_000n) + 360_000_000n) % 360_000_000n === BigInt(feature.pose.rotationDeg) * 1_000_000n,
      `${feature.reference} exact serialized pose differs`);
      requireValue(attrs.length === 1 && attrs[0]!.children.length === 0
        && attrs[0]!.values.every(atom => !atom.quoted)
        && same(attrs[0]!.values.map(atom => atom.value).sort(), ["board_only", "exclude_from_bom", "exclude_from_pos_files"]), `${feature.reference} requires exact native board-only/BOM/position exclusions`);
    }
  }
}

export function assertPcbBoardFeatureSourceBytes(library: PcbBoardFeatureLibrarySource): void {
  requireValue(same(contentIdentity(library.source), library.sourceIdentity), "library source bytes differ from source pin");
  const root = parseFreshPcbSourceDocument(`(kicad_pcb ${library.source})`);
  requireValue(root.children.length === 1 && root.children[0]!.name === "footprint"
    && root.children[0]!.values.length === 1 && root.children[0]!.values[0]!.value === library.libraryId.split(":")[1], "library source has an unexpected footprint root");
  const footprint = root.children[0]!;
  assertMechanicalSourceScope(footprint);
  requireValue(isSupportedMechanicalFootprintPads(footprint.children.filter(node => node.name === "pad").map(definition => ({ definition }))), "library is not a supported centered circular NPTH mounting hole");
}

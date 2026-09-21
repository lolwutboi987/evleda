import { parseFreshPcbReferenceGeometry } from "./fresh-kicad-parser.js";
import type { PadInventory } from "./fresh-pcb-pad-model.js";
import { collectPlaneBridgeSource } from "./plane-region-bridge-source.js";
import type { FreshPlaneDrillBore } from "./fresh-plane-drill-topology.js";
import type { TerminalCopperPad, TerminalCopperTrack, TerminalCopperVia } from "./plane-terminal-copper-paths.js";

const check = (v: unknown, reason: string): void => { if (!v) throw new Error(`Terminal copper source: ${reason}`); };
const object = (v: unknown): Record<string, unknown> => { check(v !== null && typeof v === "object" && !Array.isArray(v), "native object missing"); return v as Record<string, unknown>; };
const integer = (v: unknown): number => {
  const s = v === undefined ? "0" : String(v);
  check((v === undefined || typeof v === "string" || typeof v === "number") && /^-?(?:0|[1-9][0-9]*)$/u.test(s), "native non-integer");
  const n = Number(s); check(Number.isSafeInteger(n) && Math.abs(n) <= 2_000_000_000, "native integer bound"); return n;
};
const point = (v: unknown) => { const p = object(v); return { x: integer(p.x_nm), y: integer(p.y_nm) }; };
const layer = (s: string) => s === "BL_F_Cu" ? "F.Cu" : s === "BL_B_Cu" ? "B.Cu" : /^BL_In(?:[1-9]|[12][0-9]|30)_Cu$/u.test(s) ? s.replace(/^BL_/u, "").replace(/_Cu$/u, ".Cu") : s;

/** Consumes the already authenticated complete PAD inventory and exact drill
 * inventory. It does not acquire native authority or ignore unsupported pads. */
export function collectTerminalCopperSource(input: {
  readonly pcbSource: string; readonly inventory: PadInventory; readonly net: string;
  readonly eligiblePadUuids: readonly string[]; readonly copperLayers: readonly string[];
  readonly bores: readonly Pick<FreshPlaneDrillBore,"uuid">[];
}): { pads: TerminalCopperPad[]; vias: TerminalCopperVia[]; tracks: TerminalCopperTrack[] } {
  const bridge = collectPlaneBridgeSource(input.pcbSource, input.inventory);
  check(input.bores.length === bridge.boreCount && new Set(input.bores.map(b => b.uuid)).size === input.bores.length
    && bridge.boreEnclosures.every(b => input.bores.some(actual => actual.uuid === b.uuid)), "complete drill inventory differs");
  check(input.eligiblePadUuids.length > 0 && new Set(input.eligiblePadUuids).size === input.eligiblePadUuids.length, "eligible physical inventory");
  const pads = input.eligiblePadUuids.map((uuid): TerminalCopperPad => {
    const p = input.inventory.physicalPads.find(p => p.uuid === uuid);
    check(p !== undefined && p.netName === input.net && p.role === "numbered-copper" && p.issues.length === 0 && p.observedUsableCopperLayers !== null, "unqualified physical terminal");
    const raw = object(p!.rawNative), stack = object(raw.pad_stack), records = stack.copper_layers;
    check(stack.type === "PST_NORMAL" && stack.unconnected_layer_removal === "ULR_KEEP" && Array.isArray(records) && records.length === 1, "normal retained padstack required");
    check(p!.nativeType === "PT_SMD" || p!.nativeType === "PT_PTH", "SMD or plated through pad required");
    const copper = object((records as unknown[])[0]), offset = point(copper.offset ?? {}), size = point(copper.size), centerNm = point(raw.position);
    check(offset.x === 0 && offset.y === 0, "offset copper pad is unsupported");
    const angleValue = object(stack.angle ?? {}).value_degrees ?? 0;
    check(typeof angleValue === "number" && Number.isFinite(angleValue), "native angle");
    const angle = ((angleValue as number) % 360 + 360) % 360;
    check([0, 90, 180, 270].includes(angle), "cardinal pad required");
    const shapes: Readonly<Record<string, TerminalCopperPad["shape"]>> = { PSS_RECTANGLE: "rectangle", PSS_ROUNDRECT: "roundrect", PSS_OVAL: "oval", PSS_CIRCLE: "circle" };
    const shape = shapes[String(copper.shape)]; check(shape !== undefined, "unsupported copper shape");
    const ratio = copper.corner_rounding_ratio;
    if (shape === "roundrect") check(typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio <= 0.5, "corner ratio");
    const layers = p!.observedUsableCopperLayers!.map(layer).filter(l => input.copperLayers.includes(l));
    check(layers.length > 0 && new Set(layers).size === layers.length, "usable layer inventory");
    return { uuid, reference: p!.reference, pin: p!.number, centerNm, layers, platedThrough: p!.nativeType === "PT_PTH", shape: shape!,
      sizeNm: angle % 180 === 0 ? size : { x: size.y, y: size.x },
      cornerRadiusNm: shape === "roundrect" ? Math.ceil(Math.min(size.x, size.y) * (ratio as number)) : 0 };
  });
  const reference = parseFreshPcbReferenceGeometry(input.pcbSource);
  check(reference.issues.length === 0, "unsupported saved geometry");
  const tracks = reference.segments.filter(s => s.netName === input.net).map(s => ({ uuid: s.uuid, layer: s.layer, startNm: s.startNm, endNm: s.endNm, widthNm: s.widthNm }));
  const vias = bridge.vias.filter(v => v.netName === input.net).map(v => ({ uuid: v.uuid, centerNm: v.centerNm, diameterNm: v.diameterNm, drillNm: v.drillNm, layers: input.copperLayers }));
  check(tracks.every(t => input.copperLayers.includes(t.layer)), "track layer outside board");
  return { pads, tracks, vias };
}

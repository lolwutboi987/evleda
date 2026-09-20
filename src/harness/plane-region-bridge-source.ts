import { parseFreshPcbRouteSourceSpans, parseFreshPcbSource, parseFreshPcbSourceDocument, type FreshKicadSourceNode } from "./fresh-kicad-parser.js";
import type { PadInventory } from "./fresh-pcb-pad-model.js";
import type { PlaneBridgeBore, PlaneBridgeVia } from "./plane-region-annulus-witness.js";

const check = (value: unknown, message: string): void => { if (!value) throw new Error(`Plane bridge source: ${message}`); };
const record = (value: unknown): Record<string, unknown> => { check(value !== null && typeof value === "object" && !Array.isArray(value), "missing native object"); return value as Record<string, unknown>; };
const bounded = (n: number) => { check(Number.isSafeInteger(n) && Math.abs(n) <= 2_000_000_000, "integer coordinate/dimension bound"); return n; };
const native = (value: unknown): number => {
  const text = value === undefined ? "0" : String(value);
  check((value === undefined || typeof value === "number" || typeof value === "string") && /^-?(?:0|[1-9][0-9]{0,10})$/u.test(text), "non-exact native integer");
  return bounded(Number(text));
};
const mm = (value: string): number => {
  check(value.length <= 96, "decimal token bound");
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value); check(m !== null, "invalid source decimal");
  const exponent = Number(m![4] ?? 0), power = 6 + exponent - (m![3]?.length ?? 0);
  check(Number.isSafeInteger(exponent) && Math.abs(power) <= 30, "source exponent bound");
  let n = BigInt(m![2]! + (m![3] ?? ""));
  if (power >= 0) n *= 10n ** BigInt(power);
  else { const divisor = 10n ** BigInt(-power); check(n % divisor === 0n, "sub-nanometre source quantity"); n /= divisor; }
  return bounded(Number(m![1] === "-" ? -n : n));
};
const field = (form: FreshKicadSourceNode, name: string): FreshKicadSourceNode => {
  const found = form.children.filter(c => c.name === name); check(found.length === 1, `expected one via ${name}`); return found[0]!;
};

/** Caller must already qualify complete saved/native PAD geometry. Enclosures
 * deliberately include every bore on every layer and conservatively contain
 * oval slots/offsets; they cannot make a clipped hole disappear from a witness. */
export function collectPlaneBridgeSource(pcbSource: string, inventory: PadInventory) {
  check(inventory.unsupportedPhysicalUuids.length === 0, "unsupported physical pad inventory");
  const board = parseFreshPcbSource(pcbSource), ids = board.footprints.flatMap(f => f.pads.map(p => p.physical.id));
  check(ids.every(id => id !== null) && new Set(ids).size === ids.length && ids.length === inventory.physicalPads.length
    && new Set(inventory.physicalPads.map(p => p.uuid)).size === ids.length
    && inventory.physicalPads.every(p => ids.includes(p.uuid) && p.issues.length === 0), "complete PAD inventory mismatch");
  const bores: PlaneBridgeBore[] = [];
  for (const pad of inventory.physicalPads) {
    const raw = record(pad.rawNative), stack = record(raw.pad_stack), drill = record(stack.drill), diameter = record(drill.diameter ?? {});
    check(stack.type === "PST_NORMAL", "non-normal padstack");
    for (const name of ["secondary_drill", "tertiary_drill", "front_post_machining", "back_post_machining"])
      check(stack[name] === undefined || Object.keys(record(stack[name])).length === 0, "additional bore or machining unsupported");
    const dx = native(diameter.x_nm), dy = native(diameter.y_nm); check(dx >= 0 && dy >= 0, "negative bore diameter");
    if (dx === 0 && dy === 0) continue;
    check(dx > 0 && dy > 0 && ["DS_CIRCLE", "DS_OBLONG"].includes(String(drill.shape)), "unsupported complete bore geometry");
    const copper = stack.copper_layers; check(Array.isArray(copper) && copper.length === 1, "non-normal copper template inventory");
    const offset = record(record((copper as unknown[])[0]).offset ?? {}), position = record(raw.position);
    const enclosingDiameterNm = bounded(Math.max(dx, dy) + 2 * (Math.abs(native(offset.x_nm)) + Math.abs(native(offset.y_nm))));
    bores.push({ uuid: pad.uuid, centerNm: { x: native(position.x_nm), y: native(position.y_nm) }, enclosingDiameterNm });
  }
  const spans = parseFreshPcbRouteSourceSpans(pcbSource).filter(s => s.kind === "via"), root = parseFreshPcbSourceDocument(pcbSource);
  const forms = root.children.filter(n => n.name === "via"); check(forms.length === spans.length && forms.length === board.vias.length, "complete through-via inventory mismatch");
  const vias: (PlaneBridgeVia & { netName: string | null })[] = forms.map(form => {
    const uuid = field(form, "uuid").values[0]!.value, known = board.vias.find(v => v.id === uuid);
    check(known !== undefined && spans.some(s => s.id === uuid && s.start === form.start && s.end === form.end), "unqualified via source span");
    const at = field(form, "at"), centerNm = { x: mm(at.values[0]!.value), y: mm(at.values[1]!.value) };
    const diameterNm = mm(field(form, "size").values[0]!.value), drillNm = mm(field(form, "drill").values[0]!.value);
    check(drillNm > 0 && diameterNm > drillNm && known!.layers.length === 2 && known!.layers[0] === "F.Cu" && known!.layers[1] === "B.Cu", "ordinary through-via annulus required");
    bores.push({ uuid, centerNm, enclosingDiameterNm: drillNm }); return { uuid, netName: known!.netName, centerNm, diameterNm, drillNm };
  });
  check(bores.length <= 4096 && new Set(bores.map(b => b.uuid)).size === bores.length, "bore inventory bound or duplicate identity");
  return { vias, boreEnclosures: bores, sourcePadCount: ids.length, sourceViaCount: vias.length, boreCount: bores.length,
    boreEnclosureScope: "all-source-through-vias-and-qualified-native-pad-drills-with-conservative-offset-slot-enclosures" as const };
}

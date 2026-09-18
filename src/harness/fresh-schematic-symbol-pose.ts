import { contentIdentity } from "../core/canonical.js";
import { freshSchematicClassSourcesSupported, parseFreshSchematicPresentationSource, parseFreshSchematicSource,
  parseFreshSchematicSourceDocument, type FreshKicadSourceNode as Node, type FreshKicadSourceAtom as Atom } from "./fresh-kicad-parser.js";

export const FRESH_SCHEMATIC_SYMBOL_POSE_TOOL = "fresh_set_schematic_symbol_poses" as const;
export interface FreshSchematicSymbolPoseUpdate {
  readonly reference: string; readonly x_mm: number; readonly y_mm: number; readonly rotation: 0 | 90 | 180 | 270;
}
function need(value: unknown, message: string): asserts value { if (!value) throw new Error(`Unsupported unwired schematic pose: ${message}`); }
const named = (node: Node, name: string) => node.children.filter(child => child.name === name);
function one(node: Node, name: string): Node { const matches = named(node, name); need(matches.length === 1, `missing or duplicate ${node.name}/${name}.`); return matches[0]!; }
function scalar(node: Node): Atom { need(node.values.length === 1 && node.children.length === 0, `malformed ${node.name} scalar.`); return node.values[0]!; }
function units(value: string, places = 4, maximum = 20_000_000): number {
  need(value.length <= 64, "numeric token exceeds its bound.");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  need(match !== null && (match[2]!.length > 0 || (match[3]?.length ?? 0) > 0), "invalid decimal coordinate/angle.");
  const exponent = Number(match[4] ?? 0), power = places + exponent - (match[3]?.length ?? 0);
  need(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 64, "numeric exponent exceeds its bound.");
  let result = BigInt(match[2]! + (match[3] ?? "") || "0");
  if (power >= 0) result *= 10n ** BigInt(power);
  else { const divisor = 10n ** BigInt(-power); need(result % divisor === 0n, "pose must use exact native units."); result /= divisor; }
  if (match[1] === "-") result = -result;
  need(result >= -BigInt(maximum) && result <= BigInt(maximum), "pose exceeds its bounded coordinate/angle range."); return Number(result);
}
function millimetres(value: number): string {
  const digits = Math.abs(value).toString().padStart(5, "0"), fraction = digits.slice(-4).replace(/0+$/u, "");
  return `${value < 0 ? "-" : ""}${digits.slice(0, -4)}${fraction ? `.${fraction}` : ""}`;
}
function property(node: Node): readonly [string, string] {
  const offset = node.values[0]?.value === "private" && !node.values[0]!.quoted ? 1 : 0;
  need(node.values.length === offset + 2 && node.values.slice(offset).every(value => value.quoted), "malformed symbol property header.");
  return [node.values[offset]!.value, node.values[offset + 1]!.value];
}
const rootNames = new Set(["version", "generator", "generator_version", "uuid", "paper", "title_block", "lib_symbols", "symbol", "sheet_instances", "embedded_fonts"]);
const instanceNames = new Set(["lib_id", "at", "unit", "body_style", "convert", "uuid", "property", "pin", "instances", "exclude_from_sim", "in_bom", "on_board", "in_pos_files", "dnp", "fields_autoplaced"]);
const propertyPresentationNames = new Set(["at", "effects", "font", "size", "thickness", "bold", "italic", "justify", "hide", "show_name", "do_not_autoplace", "id", "uuid", "face", "line_spacing", "color"]);
function propertyPresentation(node: Node): void {
  for (const child of node.children) {
    need(propertyPresentationNames.has(child.name), "unknown electrical or presentation form inside an instance property.");
    propertyPresentation(child);
  }
}

/** Closed page-instance boundary; library graphics/pins are retained opaque. */
function unwiredInstances(source: string) {
  const root = parseFreshSchematicSourceDocument(source);
  need(root.values.length === 0 && root.children.every(child => rootNames.has(child.name)), "wires, labels, NCs, junctions, flags, sheets, buses and unknown root forms are not admitted.");
  need(root.children.filter(child => child.name !== "symbol").every(child => named(root, child.name).length === 1), "duplicate root metadata.");
  const ids = new Set<string>();
  const identity = (node: Node): string => {
    const value = scalar(one(node, "uuid")).value;
    need(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value) && !ids.has(value.toLowerCase()), "missing, duplicate or unsupported source UUID.");
    ids.add(value.toLowerCase()); return value;
  };
  const documentId = identity(root);
  for (const child of root.children) {
    if (["version", "generator", "generator_version", "uuid", "embedded_fonts"].includes(child.name)) scalar(child);
    if (child.name === "paper") need(child.children.length === 0 && child.values.length >= 1 && child.values.length <= 4, "unsupported paper metadata.");
    if (child.name === "title_block") {
      need(child.values.length === 0 && child.children.every(item => ["title", "date", "rev", "company", "comment"].includes(item.name)
        && item.children.length === 0 && item.values.length === (item.name === "comment" ? 2 : 1)), "unsupported title-block metadata.");
    }
    if (child.name === "sheet_instances") {
      need(child.values.length === 0 && child.children.length === 1 && child.children[0]!.name === "path", "only one root sheet instance is supported.");
      const entry = child.children[0]!;
      need(entry.values.length === 1 && entry.values[0]!.value === "/" && entry.children.length === 1 && entry.children[0]!.name === "page", "hierarchical sheet paths are unsupported.");
      scalar(entry.children[0]!);
    }
  }
  const libraries = one(root, "lib_symbols");
  need(libraries.values.length === 0 && libraries.children.every(child => child.name === "symbol" && child.values.length === 1 && child.values[0]!.quoted), "unsupported embedded symbol inventory.");
  const definitions = new Map(libraries.children.map(child => [child.values[0]!.value, child]));
  need(definitions.size === libraries.children.length, "duplicate embedded symbol definitions.");
  const parsed = parseFreshSchematicSource(source);
  need(freshSchematicClassSourcesSupported(parsed), "electrical class/directive metadata is not admitted.");
  const symbols = named(root, "symbol"), references = new Set<string>();
  need(symbols.length >= 1 && symbols.length <= 64, "source requires 1 through 64 physical root instances.");
  return symbols.map((symbol, symbolIndex) => {
    need(symbol.values.length === 0 && symbol.children.every(child => instanceNames.has(child.name)), "mirrors, alternate libraries and unknown instance forms are unsupported.");
    need(symbol.children.filter(child => !["property", "pin"].includes(child.name)).every(child => named(symbol, child.name).length === 1), "duplicate instance metadata.");
    const properties = named(symbol, "property").map(property), values = new Map(properties);
    named(symbol, "property").forEach(propertyPresentation);
    need(values.size === properties.length, "duplicate symbol properties.");
    const reference = values.get("Reference");
    need(reference !== undefined && /^[A-Z][A-Z0-9_-]{0,31}$/u.test(reference) && !references.has(reference), "flags, duplicate or unsupported references are not admitted.");
    references.add(reference);
    const libraryId = scalar(one(symbol, "lib_id")).value, definition = definitions.get(libraryId);
    need(definition !== undefined && !/^power:/iu.test(libraryId) && !/(?:^|:)PWR_FLAG$/iu.test(libraryId) && named(definition, "power").length === 0, "power/flag symbols or missing embedded definitions are not admitted.");
    need(scalar(one(symbol, "unit")).value === "1", "only single-unit root instances are admitted.");
    need(named(symbol, "body_style").length + named(symbol, "convert").length <= 1, "ambiguous body-style selectors.");
    for (const child of symbol.children) {
      if (["body_style", "convert"].includes(child.name)) need(["1", "2"].includes(scalar(child).value), "unsupported body style.");
      if (["exclude_from_sim", "in_bom", "on_board", "in_pos_files", "dnp"].includes(child.name)) need(["yes", "no"].includes(scalar(child).value), "malformed instance boolean.");
      if (child.name === "fields_autoplaced") need(child.children.length === 0 && (child.values.length === 0 || child.values.length === 1 && ["yes", "no"].includes(child.values[0]!.value)), "unsupported autoplaced metadata.");
      if (child.name === "pin") { need(child.values.length === 1 && child.values[0]!.quoted && child.children.length === 1 && child.children[0]!.name === "uuid", "alternate or unknown instance pin metadata."); identity(child); }
      if (child.name === "instances") {
        need(child.values.length === 0 && child.children.every(project => project.name === "project" && project.values.length === 1 && project.values[0]!.quoted
          && project.children.every(entry => entry.name === "path" && entry.values.length === 1 && entry.values[0]!.value === `/${documentId}`
            && entry.children.length === 2 && scalar(one(entry, "reference")).value === reference && scalar(one(entry, "unit")).value === "1")), "ambiguous or hierarchical instance reference/unit overrides.");
      }
    }
    const at = one(symbol, "at");
    need(at.children.length === 0 && at.values.length === 3 && at.values.every(atom => !atom.quoted), "instance requires existing explicit X/Y/angle tokens.");
    const x = units(at.values[0]!.value), y = units(at.values[1]!.value), angle = units(at.values[2]!.value, 0, 360);
    need(angle % 90 === 0, "noncardinal existing symbol orientation is unsupported.");
    return { reference, libraryId, symbolId: identity(symbol), symbolIndex, at,
      before: Object.freeze({ x: x / 10_000, y: y / 10_000, rotation: (angle + 360) % 360 }) };
  });
}

/** Only root-instance at tokens change; every field and electrical/source token remains exact. */
export function planFreshSchematicSymbolPoses(source: string, updates: readonly FreshSchematicSymbolPoseUpdate[]) {
  need(typeof source === "string" && source.isWellFormed() && !source.includes("\0") && Buffer.byteLength(source, "utf8") <= 8 * 1024 * 1024, "source must be bounded scalar UTF-8.");
  need(Array.isArray(updates) && updates.length >= 1 && updates.length <= 64, "updates must contain 1 through 64 entries.");
  for (const update of updates) need(update !== null && typeof update === "object" && Object.keys(update).length === 4
    && Object.keys(update).every(key => ["reference", "x_mm", "y_mm", "rotation"].includes(key))
    && /^[A-Z][A-Z0-9_-]{0,31}$/u.test(update.reference) && Number.isFinite(update.x_mm) && Number.isFinite(update.y_mm)
    && [0, 90, 180, 270].includes(update.rotation), "each update requires one exact reference, bounded X/Y and a cardinal rotation.");
  need(new Set(updates.map(update => update.reference)).size === updates.length, "update references must be unique.");
  const instances = unwiredInstances(source), presentation = parseFreshSchematicPresentationSource(source);
  const edits: { start: number; end: number; text: string }[] = [];
  const poses = updates.map(update => {
    const instance = instances.find(item => item.reference === update.reference);
    need(instance !== undefined, "requested reference is absent from this partial source.");
    const x = units(String(update.x_mm)), y = units(String(update.y_mm));
    const after = Object.freeze({ x: x / 10_000, y: y / 10_000, rotation: update.rotation });
    const change = (index: number, text: string) => { const token = instance.at.values[index]!; edits.push({ start: token.start, end: token.end, text }); };
    if (instance.before.x !== after.x) change(0, millimetres(x));
    if (instance.before.y !== after.y) change(1, millimetres(y));
    if (instance.before.rotation !== after.rotation) change(2, String(after.rotation));
    return Object.freeze({ reference: instance.reference, symbolId: instance.symbolId, before: instance.before, after,
      changed: instance.before.x !== after.x || instance.before.y !== after.y || instance.before.rotation !== after.rotation });
  });
  // Retained fields feed the existing glyph diagnostic, never a field edit.
  const fields = instances.filter(instance => updates.some(update => update.reference === instance.reference)).flatMap(instance =>
    presentation.symbolFields.filter(field => field.symbolIndex === instance.symbolIndex).map(field => {
      need(field.sourcePresent && field.text !== null && field.at !== null, "target Reference/Value fields require existing explicit positions.");
      return Object.freeze({ reference: instance.reference, field: field.kind, symbolId: instance.symbolId, text: field.text, hidden: field.hidden,
        before: field.at, after: field.at, changed: false });
    }));
  edits.sort((a, b) => a.start - b.start); let cursor = 0; const pieces: string[] = [];
  for (const edit of edits) { need(edit.start >= cursor, "pose spans overlap."); pieces.push(source.slice(cursor, edit.start), edit.text); cursor = edit.end; }
  pieces.push(source.slice(cursor)); const planned = pieces.join("");
  return Object.freeze({ source: planned, changed: edits.length > 0, poses: Object.freeze(poses), fields: Object.freeze(fields),
    observedReferences: Object.freeze(instances.map(instance => instance.reference)), beforeIdentity: contentIdentity(source), afterIdentity: contentIdentity(planned) });
}

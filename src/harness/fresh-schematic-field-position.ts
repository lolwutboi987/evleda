import { contentIdentity } from "../core/canonical.js";
import { parseFreshSchematicPresentationSource, parseFreshSchematicSourceDocument,
  type FreshKicadSourceNode, type FreshKicadSourceAtom } from "./fresh-kicad-parser.js";
import type { FreshSchematicStrokeStyleEvidence } from "./fresh-schematic-stroke-style.js";

export const FRESH_SCHEMATIC_FIELD_POSITION_TOOL = "fresh_set_schematic_field_positions" as const;
export interface FreshSchematicFieldPositionUpdate {
  readonly reference: string; readonly field: "Reference" | "Value"; readonly x_mm: number; readonly y_mm: number;
}
function need(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Unsupported schematic field position: ${message}`);
}
const named = (node: FreshKicadSourceNode, name: string) => node.children.filter(child => child.name === name);
function units(value: string): number {
  need(value.length <= 64, "coordinate token is excessive.");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  need(match !== null && (match[2]!.length > 0 || (match[3]?.length ?? 0) > 0), "coordinate is not a decimal number.");
  const exponent = Number(match[4] ?? 0), power = 4 + exponent - (match[3]?.length ?? 0);
  need(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 64, "coordinate exponent is unsupported.");
  let result = BigInt(match[2]! + (match[3] ?? "") || "0");
  if (power >= 0) result *= 10n ** BigInt(power);
  else { const divisor = 10n ** BigInt(-power); need(result % divisor === 0n, "coordinate is not exact 0.0001 mm native schematic units."); result /= divisor; }
  if (match[1] === "-") result = -result;
  need(result >= -20_000_000n && result <= 20_000_000n, "coordinate exceeds the 2000 mm source bound.");
  return Number(result);
}
function millimetres(value: number): string {
  const digits = Math.abs(value).toString().padStart(5, "0"), fraction = digits.slice(-4).replace(/0+$/u, "");
  return `${value < 0 ? "-" : ""}${digits.slice(0, -4)}${fraction ? `.${fraction}` : ""}`;
}
function propertyName(node: FreshKicadSourceNode): string {
  const offset = node.values[0]?.value === "private" && !node.values[0]!.quoted ? 1 : 0;
  need(node.values.length === offset + 2 && node.values.slice(offset).every(atom => atom.quoted), "property header is not exact quoted source.");
  return node.values[offset]!.value;
}

/** All edits are validated first. Only existing X/Y tokens can be replaced. */
export function planFreshSchematicFieldPositions(source: string, updates: readonly FreshSchematicFieldPositionUpdate[]) {
  need(typeof source === "string" && source.isWellFormed() && !source.includes("\0") && Buffer.byteLength(source, "utf8") <= 8 * 1024 * 1024,
    "source must be bounded scalar UTF-8.");
  need(Array.isArray(updates) && updates.length >= 1 && updates.length <= 128, "updates must contain 1 through 128 entries.");
  need(new Set(updates.map(update => `${update.reference}:${update.field}`)).size === updates.length, "reference/field pairs must be unique.");
  const root = parseFreshSchematicSourceDocument(source), symbols = named(root, "symbol");
  const presentation = parseFreshSchematicPresentationSource(source);
  const edits: { start: number; end: number; text: string }[] = [];
  const fields = updates.map(update => {
    need(update !== null && typeof update === "object" && Object.keys(update).length === 4
      && Object.keys(update).every(key => ["reference", "field", "x_mm", "y_mm"].includes(key))
      && /^[A-Z][A-Z0-9_-]{0,31}$/u.test(update.reference) && ["Reference", "Value"].includes(update.field)
      && Number.isFinite(update.x_mm) && Number.isFinite(update.y_mm), "update must select one exact Reference/Value position.");
    const x = units(String(update.x_mm)), y = units(String(update.y_mm));
    const matches = symbols.flatMap((symbol, symbolIndex) => named(symbol, "property").some(prop => propertyName(prop) === "Reference"
      && prop.values.at(-1)!.value === update.reference) ? [{ symbol, symbolIndex }] : []);
    need(matches.length === 1, "reference must select exactly one root symbol.");
    const { symbol, symbolIndex } = matches[0]!;
    const properties = named(symbol, "property"), names = properties.map(propertyName);
    need(new Set(names).size === names.length, "selected symbol has duplicate properties.");
    const propertiesForField = properties.filter(prop => propertyName(prop) === update.field);
    need(propertiesForField.length === 1, "selected existing field is missing or ambiguous.");
    const field = propertiesForField[0]!, at = named(field, "at");
    need(at.length === 1 && at[0]!.children.length === 0 && [2, 3].includes(at[0]!.values.length)
      && at[0]!.values.every(atom => !atom.quoted && Number.isFinite(Number(atom.value))), "field lacks a complete explicit native position.");
    const original = at[0]!.values, beforeX = units(original[0]!.value), beforeY = units(original[1]!.value);
    const uuids = named(symbol, "uuid");
    need(uuids.length === 1 && uuids[0]!.children.length === 0 && uuids[0]!.values.length === 1
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(uuids[0]!.values[0]!.value), "symbol lacks one stable UUID.");
    const add = (atom: FreshKicadSourceAtom, value: number) => edits.push({ start: atom.start, end: atom.end, text: millimetres(value) });
    if (beforeX !== x) add(original[0]!, x);
    if (beforeY !== y) add(original[1]!, y);
    const observed = presentation.symbolFields.find(item => item.symbolIndex === symbolIndex && item.kind === update.field)!;
    return Object.freeze({ reference: update.reference, field: update.field, symbolId: uuids[0]!.values[0]!.value,
      text: field.values.at(-1)!.value, hidden: observed.hidden, before: Object.freeze({ x: beforeX / 10_000, y: beforeY / 10_000 }),
      after: Object.freeze({ x: x / 10_000, y: y / 10_000 }), changed: beforeX !== x || beforeY !== y });
  });
  edits.sort((a, b) => a.start - b.start);
  let cursor = 0; const pieces: string[] = [];
  for (const edit of edits) { need(edit.start >= cursor, "coordinate spans overlap."); pieces.push(source.slice(cursor, edit.start), edit.text); cursor = edit.end; }
  pieces.push(source.slice(cursor));
  const planned = pieces.join("");
  return Object.freeze({ source: planned, changed: edits.length > 0, fields: Object.freeze(fields), beforeIdentity: contentIdentity(source), afterIdentity: contentIdentity(planned) });
}

/** Literal text candidates document native ink; they do not infer field ownership. */
export function schematicFieldPositionGlyphDiagnostic(plan: ReturnType<typeof planFreshSchematicFieldPositions>, style: FreshSchematicStrokeStyleEvidence) {
  return Object.freeze({ nativeSvgIdentity: style.nativeSvgIdentity, strokeStyleIdentity: style.identity,
    completeGlyphCoverage: style.nativeText.completeCoverage, association: "literal-text-candidates-not-field-ownership" as const,
    targetCount: plan.fields.length, returned: Math.min(plan.fields.length, 16), truncated: plan.fields.length > 16,
    fields: Object.freeze(plan.fields.slice(0, 16).map(field => {
      const matches = style.nativeText.bounds.filter(ink => ink.text === field.text);
      return Object.freeze({ reference: field.reference, field: field.field, hidden: field.hidden, candidateCount: matches.length,
        uniqueCandidate: matches.length !== 1 ? null : Object.freeze({ groupIndex: matches[0]!.textGroupIndex,
          minX: matches[0]!.minX, minY: matches[0]!.minY, maxX: matches[0]!.maxX, maxY: matches[0]!.maxY }) });
    })) });
}

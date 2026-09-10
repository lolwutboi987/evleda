import { parseFreshPcbTextItems } from "./fresh-kicad-parser.js";
import { freshBoardSerializationsEqual } from "./fresh-board-serialization.js";

export interface PcbSilkscreenText {
  readonly text: string; readonly x_mm: number; readonly y_mm: number;
  readonly layer: "F_SilkS"; readonly size_mm: number; readonly rotation_deg: 0;
  readonly bold: boolean; readonly italic: boolean;
}
export const PCB_SILKSCREEN_TEXT_SCHEMA = Object.freeze({ type: "object", additionalProperties: false,
  properties: { text: { type: "string", minLength: 1, maxLength: 64, pattern: "^(?!.*\\$\\{)[ -~]+$" },
    x_mm: { type: "number", minimum: 0, maximum: 2000 }, y_mm: { type: "number", minimum: 0, maximum: 2000 },
    layer: { type: "string", enum: ["F_SilkS"], default: "F_SilkS" },
    size_mm: { type: "number", minimum: 0.6, maximum: 3, default: 1 },
    rotation_deg: { type: "number", enum: [0], default: 0 }, bold: { type: "boolean", default: false }, italic: { type: "boolean", default: false } },
  required: ["text", "x_mm", "y_mm"] });

export function parsePcbSilkscreenText(value: Readonly<Record<string, unknown>>): PcbSilkscreenText {
  if (Object.keys(value).some(key => !Object.hasOwn(PCB_SILKSCREEN_TEXT_SCHEMA.properties, key))
      || typeof value.text !== "string" || value.text.length < 1 || value.text.length > 64
      || !/^[ -~]+$/u.test(value.text) || value.text.includes("${")
      || typeof value.x_mm !== "number" || !Number.isFinite(value.x_mm) || value.x_mm < 0 || value.x_mm > 2000
      || typeof value.y_mm !== "number" || !Number.isFinite(value.y_mm) || value.y_mm < 0 || value.y_mm > 2000
      || (value.layer !== undefined && value.layer !== "F_SilkS") || (value.rotation_deg !== undefined && value.rotation_deg !== 0)
      || (value.size_mm !== undefined && (typeof value.size_mm !== "number" || !Number.isFinite(value.size_mm) || value.size_mm < 0.6 || value.size_mm > 3))
      || (value.bold !== undefined && typeof value.bold !== "boolean") || (value.italic !== undefined && typeof value.italic !== "boolean")) {
    throw new Error("PCB text requires bounded literal text, coordinates, F_SilkS, and verified zero rotation.");
  }
  return Object.freeze({ text: value.text, x_mm: value.x_mm, y_mm: value.y_mm, layer: "F_SilkS",
    size_mm: value.size_mm as number | undefined ?? 1, rotation_deg: 0,
    bold: value.bold as boolean | undefined ?? false, italic: value.italic as boolean | undefined ?? false });
}

/** Remove only the exact new text span, then compare every remaining source token. */
export function assertOnlyRequestedPcbTextAdded(before: string, after: string, expected: PcbSilkscreenText): void {
  const original = parseFreshPcbTextItems(before), current = parseFreshPcbTextItems(after);
  const ids = new Set(original.map(item => item.id));
  const added = current.filter(item => !ids.has(item.id));
  if (current.length !== original.length + 1 || added.length !== 1) throw new Error("PCB text mutation did not add exactly one identified text item.");
  const text = added[0]!;
  if (text.id === null || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(text.id) || before.includes(text.id)) {
    throw new Error("New PCB text lacks a unique native item identity.");
  }
  const p = text.presentation;
  if (!text.supported || text.text !== expected.text || text.layer !== "F.SilkS" || p.at?.x !== expected.x_mm || p.at?.y !== expected.y_mm
      || (p.rotationDeg ?? 0) !== 0 || p.fontSizeMm?.x !== expected.size_mm || p.fontSizeMm?.y !== expected.size_mm
      || p.bold !== expected.bold || p.italic !== expected.italic || p.hidden
      || p.justify?.length !== 2 || !p.justify.includes("left") || !p.justify.includes("bottom")) {
    throw new Error("Native PCB text differs from the exact requested presentation.");
  }
  const remaining = after.slice(0, text.start) + after.slice(text.end);
  if (!freshBoardSerializationsEqual(before, remaining)) throw new Error("PCB text mutation changed preexisting board content.");
}

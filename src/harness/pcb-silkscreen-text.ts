import { parseFreshPcbTextItems, parseFreshPcbSourceDocument } from "./fresh-kicad-parser.js";
import { freshBoardSerializationsEqual } from "./fresh-board-serialization.js";
import { routeMmToNativeNm, routeNativeNmToKipyMm, routeNativeNmToMm } from "./fresh-route-native-units.js";

export type PcbSilkscreenRotation = 0 | 90 | 180 | 270;
const rotations = Object.freeze([0, 90, 180, 270] as const);

export interface PcbSilkscreenText {
  readonly text: string; readonly x_mm: number; readonly y_mm: number;
  readonly layer: "F_SilkS"; readonly size_mm: number; readonly rotation_deg: PcbSilkscreenRotation;
  readonly bold: boolean; readonly italic: boolean;
}
export const PCB_SILKSCREEN_TEXT_SCHEMA = Object.freeze({ type: "object", additionalProperties: false,
  properties: { text: { type: "string", minLength: 1, maxLength: 64, pattern: "^(?!.*\\$\\{)[ -~]+$" },
    x_mm: { type: "number", minimum: 0, maximum: 2000 }, y_mm: { type: "number", minimum: 0, maximum: 2000 },
    layer: { type: "string", enum: ["F_SilkS"], default: "F_SilkS" },
    size_mm: { type: "number", minimum: 0.8, maximum: 3, default: 1 },
    rotation_deg: { type: "number", enum: rotations, default: 0 }, bold: { type: "boolean", default: false }, italic: { type: "boolean", default: false } },
  required: ["text", "x_mm", "y_mm"] });

export function parsePcbSilkscreenText(value: Readonly<Record<string, unknown>>): PcbSilkscreenText {
  if (Object.keys(value).some(key => !Object.hasOwn(PCB_SILKSCREEN_TEXT_SCHEMA.properties, key))
      || typeof value.text !== "string" || value.text.length < 1 || value.text.length > 64
      || !/^[ -~]+$/u.test(value.text) || value.text.includes("${")
      || typeof value.x_mm !== "number" || !Number.isFinite(value.x_mm) || value.x_mm < 0 || value.x_mm > 2000
      || typeof value.y_mm !== "number" || !Number.isFinite(value.y_mm) || value.y_mm < 0 || value.y_mm > 2000
      || (value.layer !== undefined && value.layer !== "F_SilkS")
      || (value.rotation_deg !== undefined && !rotations.includes(value.rotation_deg as PcbSilkscreenRotation))
      || (value.size_mm !== undefined && (typeof value.size_mm !== "number" || !Number.isFinite(value.size_mm) || value.size_mm < 0.8 || value.size_mm > 3))
      || (value.bold !== undefined && typeof value.bold !== "boolean") || (value.italic !== undefined && typeof value.italic !== "boolean")) {
    throw new Error("PCB text requires bounded literal text, coordinates, F_SilkS, and cardinal rotation.");
  }
  // Materialize the request once in KiCad's integer-nanometre domain. Actual
  // readback is still compared exactly; it is never rounded into compliance.
  const materialized = (mm: number) => routeNativeNmToMm(routeMmToNativeNm(mm));
  return Object.freeze({ text: value.text, x_mm: materialized(value.x_mm), y_mm: materialized(value.y_mm), layer: "F_SilkS",
    size_mm: materialized(value.size_mm as number | undefined ?? 1), rotation_deg: value.rotation_deg as PcbSilkscreenRotation | undefined ?? 0,
    bold: value.bold as boolean | undefined ?? false, italic: value.italic as boolean | undefined ?? false });
}

/** Pinned KiPy Vector2 conversion truncates mm*1e6 for positions and font size. */
export function pcbSilkscreenNativeArguments(requested: PcbSilkscreenText): PcbSilkscreenText {
  const wire = (mm: number) => routeNativeNmToKipyMm(routeMmToNativeNm(mm));
  return Object.freeze({ ...requested, x_mm: wire(requested.x_mm), y_mm: wire(requested.y_mm), size_mm: wire(requested.size_mm) });
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
  const native = parseFreshPcbSourceDocument(after).children.find(node => node.start === text.start)!;
  const fonts = native.children.filter(node => node.name === "effects").flatMap(node => node.children.filter(child => child.name === "font"));
  const thicknesses = fonts.flatMap(node => node.children.filter(child => child.name === "thickness"));
  const thickness = thicknesses[0]?.values[0];
  // Pinned KiCad 10.0.3: omitted stroke is automatic, not zero ink.
  // common/eda_text.cpp GetEffectiveTextPenWidth; common/gr_text.cpp normal
  // width=size/8, bold=size/5, clamp=size/4. DRC text_dims uses effective width.
  // https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.3/common/eda_text.cpp
  // https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.3/common/gr_text.cpp
  // The admitted isotropic stock font has a conservative automatic lower bound
  // of size/8 >= 0.1 mm. Outline fonts/unknown metadata remain unsupported.
  const automatic = thicknesses.length === 0 && p.fontSizeMm !== null && p.fontSizeMm.x >= 0.8 && p.fontSizeMm.y >= 0.8;
  const explicit = thicknesses.length === 1 && thicknesses[0]!.children.length === 0 && thicknesses[0]!.values.length === 1
    && thickness !== undefined && !thickness.quoted && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(thickness.value)
    && Number.isFinite(Number(thickness.value)) && Number(thickness.value) >= 0.08;
  if (fonts.length !== 1 || !automatic && !explicit) {
    throw new Error("Native PCB text does not preserve the existing 0.08 mm minimum stroke thickness.");
  }
  if (!text.supported || text.text !== expected.text || text.layer !== "F.SilkS" || p.at?.x !== expected.x_mm || p.at?.y !== expected.y_mm
      || !Number.isInteger(p.rotationDeg ?? 0) || (((p.rotationDeg ?? 0) % 360) + 360) % 360 !== expected.rotation_deg
      || p.fontSizeMm?.x !== expected.size_mm || p.fontSizeMm?.y !== expected.size_mm || expected.size_mm < 0.8
      || p.bold !== expected.bold || p.italic !== expected.italic || p.hidden
      || p.justify?.length !== 2 || !p.justify.includes("left") || !p.justify.includes("bottom")) {
    throw new Error("Native PCB text differs from the exact requested presentation.");
  }
  const remaining = after.slice(0, text.start) + after.slice(text.end);
  if (!freshBoardSerializationsEqual(before, remaining)) throw new Error("PCB text mutation changed preexisting board content.");
}

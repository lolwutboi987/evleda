import type { FreshBounds, FreshPoint } from "./fresh-kicad-parser.js";

/** Pinned stock-font/passive-frame envelope. Current-source native checks remain separate. */
export const FRESH_LABEL_PLANNING_MODEL = Object.freeze({
  schemaVersion: "evleda.fresh-global-label-planning-envelope.v2",
  textModel: "kicad-10.0.3-stock-stroke-ascii-passive-frame",
  approximate: false,
  fontMm: 1.524,
  font: "KiCad Font",
  shape: "passive",
  labelSizeRatio: 0.375,
  plotStrokeMm: 0.1524,
  coordinateQuantumMm: 0.0001,
  supportedCharacters: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_+./-",
});

// Stock stroke advances in 1/21-em units, independently checked by the native
// fixture. These are numeric metrics, not a replacement glyph renderer.
// Source: KiCad 10.0.3 common/newstroke_font.cpp and common/font/stroke_font.cpp.
const advances = Object.freeze([
  18, 21, 21, 21, 19, 18, 21, 22, 10, 16, 21, 17, 24, 22, 22, 21, 22, 21, 20, 16, 22, 18, 24, 20, 18, 20,
  19, 19, 18, 19, 18, 12, 19, 19, 10, 10, 17, 11, 28, 19, 19, 19, 19, 13, 17, 12, 19, 16, 22, 17, 16, 17,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 16, 26, 10, 22, 26,
]);

/** KiCad rotates text axes; top/bottom alone leave longitudinal justification centered. */
export function freshGlobalLabelJustification(rotationDeg: number): "left" | "right" | null {
  return rotationDeg === 0 || rotationDeg === 90 ? "left" : rotationDeg === 180 || rotationDeg === 270 ? "right" : null;
}

export interface FreshPlannedGlobalLabel {
  readonly name: string;
  readonly endpointId: string;
  readonly at: FreshPoint;
  readonly rotationDeg: 0 | 90 | 180 | 270;
  readonly justify: "left" | "right" | "top" | "bottom";
  readonly fontMm: 1.524;
  readonly bounds: FreshBounds;
}

/** Pin angles point into the symbol; label text must extend in the opposite direction. */
export function freshGlobalLabelOrientation(angleDeg: 0 | 90 | 180 | 270): Pick<FreshPlannedGlobalLabel, "rotationDeg" | "justify"> {
  switch (angleDeg) {
    case 0: return { rotationDeg: 180, justify: "right" };
    case 90: return { rotationDeg: 270, justify: "right" };
    case 180: return { rotationDeg: 0, justify: "left" };
    case 270: return { rotationDeg: 90, justify: "left" };
  }
}

/**
 * Compatibility name retained for callers. The supported envelope now follows
 * KiCad 10.0.3 SCH_GLOBALLABEL::CreateGraphicShape, StringBoundaryLimits and the
 * stock stroke advances, in 10,000 schematic IU/mm. Plain supported text only:
 * substitutions, markup, other Unicode/fonts/styles require separate evidence.
 * Includes the complete frame stroke and one SVG coordinate quantum outward.
 * This is still planning geometry, not a current-source native clearance proof.
 */
export function approximateFreshGlobalLabelBounds(name: string, at: FreshPoint, rotationDeg: 0 | 90 | 180 | 270): FreshBounds | null {
  if (name.length === 0 || name.length > 128 || !/^[A-Za-z0-9_+./-]+$/u.test(name) || ![0, 90, 180, 270].includes(rotationDeg)
      || !Number.isFinite(at.x) || !Number.isFinite(at.y) || Math.abs(at.x) > 2000 || Math.abs(at.y) > 2000) return null;
  const model = FRESH_LABEL_PLANNING_MODEL;
  const font = 15240, pen = font / 8, expansion = Math.round(font * model.labelSizeRatio);
  const advance = [...name].reduce((sum, char) => sum + Math.round(font * advances[model.supportedCharacters.indexOf(char)]! / 21), 0);
  // Stock text bounding box subtracts 0.2em, then inflates by round(1.5*pen)
  // on each side. The passive frame adds two expansions, pen, and three IU.
  const textWidth = advance - Math.round(font * 0.2) + 2 * Math.round(1.5 * pen);
  const stroke = model.plotStrokeMm / 2 + model.coordinateQuantumMm;
  const length = (textWidth + 2 * expansion + pen + 3) / 10000 + stroke;
  const halfHeight = (font / 2 + expansion + pen + 3) / 10000 + stroke;
  if (rotationDeg === 0) return { minX: at.x - stroke, maxX: at.x + length, minY: at.y - halfHeight, maxY: at.y + halfHeight };
  if (rotationDeg === 180) return { minX: at.x - length, maxX: at.x + stroke, minY: at.y - halfHeight, maxY: at.y + halfHeight };
  if (rotationDeg === 90) return { minX: at.x - halfHeight, maxX: at.x + halfHeight, minY: at.y - length, maxY: at.y + stroke };
  return { minX: at.x - halfHeight, maxX: at.x + halfHeight, minY: at.y - stroke, maxY: at.y + length };
}

/** Only the intentional incoming wire may touch this label's stroked connection face. */
export function freshGlobalLabelOwnPortTouch(label: FreshPlannedGlobalLabel,
  wire: { readonly start: FreshPoint; readonly end: FreshPoint }, net: string, endpointIds: readonly string[]): boolean {
  if (net !== label.name || !endpointIds.includes(label.endpointId) || label.fontMm !== 1.524
    || label.justify !== freshGlobalLabelJustification(label.rotationDeg)) return false;
  const expected = approximateFreshGlobalLabelBounds(label.name, label.at, label.rotationDeg);
  if (expected === null || (["minX", "minY", "maxX", "maxY"] as const).some(key => expected[key] !== label.bounds[key])) return false;
  const same = (point: FreshPoint) => point.x === label.at.x && point.y === label.at.y;
  const other = same(wire.start) ? wire.end : same(wire.end) ? wire.start : null;
  if (other === null || !Number.isFinite(other.x) || !Number.isFinite(other.y)) return false;
  const cap = FRESH_LABEL_PLANNING_MODEL.plotStrokeMm / 2 + FRESH_LABEL_PLANNING_MODEL.coordinateQuantumMm;
  // The other endpoint must be outside the back stroke. No tangent, offset,
  // through-label, wrong-net or wrong-owner path receives this exception.
  if (label.rotationDeg === 0) return other.y === label.at.y && other.x < label.at.x - cap;
  if (label.rotationDeg === 180) return other.y === label.at.y && other.x > label.at.x + cap;
  if (label.rotationDeg === 90) return other.x === label.at.x && other.y > label.at.y + cap;
  return other.x === label.at.x && other.y < label.at.y - cap;
}

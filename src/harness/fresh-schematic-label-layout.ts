import type { FreshBounds, FreshPoint } from "./fresh-kicad-parser.js";

/** Planning envelope only. Actual rendered ink is checked separately. */
export const FRESH_LABEL_PLANNING_MODEL = Object.freeze({
  schemaVersion: "evleda.fresh-global-label-planning-envelope.v1",
  textModel: "kicad-mcp-utils.geometry.text_extent-0.66",
  approximate: true,
  fontMm: 1.524,
  glyphAspect: 0.66,
  longitudinalPaddingMm: 1.27,
  transversePaddingMm: 0.635,
});

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
    case 90: return { rotationDeg: 270, justify: "top" };
    case 180: return { rotationDeg: 0, justify: "left" };
    case 270: return { rotationDeg: 90, justify: "bottom" };
  }
}

/**
 * Reuse the pinned sidecar's simple text_extent model, with explicit padding
 * for terminal framing. This is NOT a font engine or native clearance proof.
 * Unsupported/control text is refused instead of receiving a guessed extent.
 */
export function approximateFreshGlobalLabelBounds(name: string, at: FreshPoint, rotationDeg: 0 | 90 | 180 | 270): FreshBounds | null {
  if (name.length === 0 || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)
      || !name.isWellFormed() || ![0, 90, 180, 270].includes(rotationDeg)
      || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  const model = FRESH_LABEL_PLANNING_MODEL;
  // Python len() counts Unicode code points, not JavaScript UTF-16 units.
  const length = [...name].length * model.fontMm * model.glyphAspect + 2 * model.longitudinalPaddingMm;
  const halfHeight = model.fontMm / 2 + model.transversePaddingMm;
  if (rotationDeg === 0) return { minX: at.x, maxX: at.x + length, minY: at.y - halfHeight, maxY: at.y + halfHeight };
  if (rotationDeg === 180) return { minX: at.x - length, maxX: at.x, minY: at.y - halfHeight, maxY: at.y + halfHeight };
  if (rotationDeg === 90) return { minX: at.x - halfHeight, maxX: at.x + halfHeight, minY: at.y - length, maxY: at.y };
  return { minX: at.x - halfHeight, maxX: at.x + halfHeight, minY: at.y, maxY: at.y + length };
}

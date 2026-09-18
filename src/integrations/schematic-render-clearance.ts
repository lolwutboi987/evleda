import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { validateCanonicalIdentity, validateContentIdentity } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { KicadSchematicSourceIdentities, KicadSchematicSvgResult } from "./kicad-cli.js";

export const SCHEMATIC_RENDER_CLEARANCE_SCHEMA_VERSION = "evleda.schematic-render-clearance.v1" as const;
export const SCHEMATIC_RENDER_CLEARANCE_POLICY = Object.freeze({
  schemaVersion: "evleda.schematic-render-clearance-policy.v1",
  scope: "native-ink-clearance-only" as const,
  primitives: Object.freeze(["absolute-M-L-Z", "rect", "circle"]),
  stroke: "round-caps-and-joins", paint: "black-native-ink", coordinateUnits: "mm", numericalToleranceMm: 0.000001,
  hiddenTextMetadata: "native-text-or-single-invisible-cardinal-rotation-wrapper",
  planningOnlyNontextLeafFillRules: Object.freeze(["nonzero", "evenodd"]),
  // The source-bound 62-part RP2350 render has 21,080 elements / 1,181,482
  // bytes before terminal labels. Increase XML capacity, retaining the separate
  // glyph primitive, text-group, depth and collision-work ceilings below.
  maxSvgBytes: 4 * 1024 * 1024, maxElements: 64_000, maxDepth: 32, maxSegments: 30_000,
  maxTextGroups: 1_000, maxComparisons: 2_000_000, maxWitnesses: 128,
});
export const SCHEMATIC_RENDER_CLEARANCE_POLICY_IDENTITY = Object.freeze(canonicalIdentity(SCHEMATIC_RENDER_CLEARANCE_POLICY, SCHEMATIC_RENDER_CLEARANCE_POLICY.schemaVersion));

export interface SchematicInkPoint { readonly x: number; readonly y: number }
export interface SchematicInkObject {
  /** Zero-based opening-element index in the exact raw SVG, including metadata elements. */
  readonly elementIndex: number;
  /** Zero-based native stroked-text group index; null for nontext geometry. */
  readonly textGroupIndex: number | null;
  readonly text: string | null;
}
export interface SchematicInkCollision {
  readonly kind: "text-text" | "text-geometry";
  readonly a: SchematicInkObject;
  readonly b: SchematicInkObject;
  readonly pointAMm: SchematicInkPoint;
  readonly pointBMm: SchematicInkPoint;
  readonly inkGapMm: number;
}
export interface SchematicInkUnsupported { readonly code: string; readonly elementIndex: number | null }
export interface SchematicInkAnalysis {
  readonly scope: "native-ink-clearance-only";
  readonly status: "pass" | "fail" | "unknown";
  readonly completeCoverage: boolean;
  readonly textGroupCount: number;
  readonly primitiveCount: number;
  readonly comparisons: number;
  readonly collisions: readonly SchematicInkCollision[];
  readonly witnessesTruncated: boolean;
  readonly unsupported: readonly SchematicInkUnsupported[];
  readonly limitations: readonly string[];
}
export interface SchematicRenderClearanceExpected {
  readonly sources: KicadSchematicSourceIdentities;
  readonly executable: Readonly<{ sha256: string; sizeBytes: number }>;
  /** Caller must verify the full current validation binding before invoking this host-only collector. */
  readonly validationSourceBindingIdentity: CanonicalIdentity;
}
export interface SchematicRenderClearanceEvidence extends SchematicInkAnalysis {
  readonly schemaVersion: typeof SCHEMATIC_RENDER_CLEARANCE_SCHEMA_VERSION;
  readonly policyIdentity: CanonicalIdentity;
  readonly sources: KicadSchematicSourceIdentities;
  readonly sourceSetIdentity: CanonicalIdentity;
  readonly validationSourceBindingIdentity: CanonicalIdentity;
  readonly executableIdentity: ContentIdentity;
  readonly invocationIdentity: CanonicalIdentity;
  readonly nativeSvgIdentity: ContentIdentity;
  readonly bindingProblems: readonly string[];
  readonly identity: CanonicalIdentity;
}
const hostReceipts = new WeakSet<object>();

const LIMITATIONS = Object.freeze([
  "Checks native visible text ink against other text groups and supported visible geometry only.",
  "Does not establish compactness, circuit organization, professional readability, electrical correctness, or manufacturing release.",
  "Witnesses identify exact SVG elements; no schematic UUID or field ownership is inferred.",
]);
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
type Point = SchematicInkPoint;
interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string; index: number }
class UnsupportedSvg extends Error { constructor(readonly code: string, readonly elementIndex: number | null = null) { super(code); } }
function unsupported(code: string, elementIndex: number | null = null): never { throw new UnsupportedSvg(code, elementIndex); }
const number = (value: string | undefined, index: number): number => {
  if (value === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value.trim())) return unsupported("UNSUPPORTED_NUMBER_OR_UNIT", index);
  const result = Number(value);
  return Number.isFinite(result) && Math.abs(result) <= 100_000 ? result : unsupported("UNBOUNDED_NUMBER", index);
};
const decode = (value: string): string => value.replace(/&([^;]*);|&/gu, (whole, entity: string | undefined) => {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  if (entity !== undefined && Object.hasOwn(named, entity)) return named[entity]!;
  if (entity !== undefined && /^(?:#\d+|#x[\da-fA-F]+)$/u.test(entity)) {
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (Number.isSafeInteger(code) && (code === 9 || code === 10 || code === 13 || code >= 32) && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
  }
  return unsupported("UNSUPPORTED_XML_ENTITY");
});

/** Closed bounded SVG reader: never resolves DTDs, URLs, fonts, CSS, or external entities. */
function parseXml(source: string): XmlNode {
  const stack: XmlNode[] = []; let root: XmlNode | undefined; let cursor = 0; let count = 0;
  while (cursor < source.length) {
    if (source[cursor] !== "<") {
      const next = source.indexOf("<", cursor); const end = next < 0 ? source.length : next;
      const text = decode(source.slice(cursor, end));
      if (stack.length > 0) stack.at(-1)!.text += text;
      else if (text.replace(/^\uFEFF/u, "").trim()) unsupported("TEXT_OUTSIDE_SVG");
      cursor = end; continue;
    }
    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4); if (end < 0) unsupported("MALFORMED_XML"); cursor = end + 3; continue;
    }
    let end = cursor + 1; let quote = "";
    for (; end < source.length; end++) {
      const char = source[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end >= source.length) unsupported("MALFORMED_XML");
    const token = source.slice(cursor + 1, end).trim(); cursor = end + 1;
    if (token.startsWith("?xml ") && token.endsWith("?") && root === undefined) continue;
    if (token.startsWith("!DOCTYPE svg ") && !token.includes("[") && root === undefined) continue;
    if (token.startsWith("!") || token.startsWith("?")) unsupported("UNSUPPORTED_XML_DECLARATION");
    if (token.startsWith("/")) {
      if (stack.pop()?.name !== token.slice(1).trim()) unsupported("MALFORMED_XML");
      continue;
    }
    const match = /^([A-Za-z_][\w:.-]*)([\s\S]*?)\/?$/u.exec(token);
    if (!match) unsupported("MALFORMED_XML");
    const name = match[1]!; let rest = match[2]!; const attrs: Record<string, string> = Object.create(null);
    while (rest.trim()) {
      const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(rest);
      if (!attribute || Object.hasOwn(attrs, attribute[1]!)) unsupported("MALFORMED_OR_DUPLICATE_ATTRIBUTE");
      const raw = attribute[2] ?? attribute[3]!; if (raw.includes("<")) unsupported("MALFORMED_XML_ATTRIBUTE");
      attrs[attribute[1]!] = decode(raw); rest = rest.slice(attribute[0].length);
    }
    if (count >= SCHEMATIC_RENDER_CLEARANCE_POLICY.maxElements || stack.length >= SCHEMATIC_RENDER_CLEARANCE_POLICY.maxDepth) unsupported("SVG_STRUCTURE_LIMIT");
    const node: XmlNode = { name, attrs, children: [], text: "", index: count++ };
    if (stack.length) stack.at(-1)!.children.push(node);
    else { if (root !== undefined) unsupported("MULTIPLE_SVG_ROOTS"); root = node; }
    if (!token.endsWith("/")) stack.push(node);
  }
  if (stack.length || root?.name !== "svg") unsupported("MALFORMED_SVG_ROOT");
  return root;
}

interface Style { fill: string; stroke: string; width: number; opacity: number; fillOpacity: number; strokeOpacity: number; cap: string; join: string }
const DEFAULT_STYLE: Style = { fill: "black", stroke: "none", width: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1, cap: "butt", join: "miter" };
const STYLE_KEYS = new Set(["fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "fill-rule"]);
function styleFor(node: XmlNode, inherited: Style, omittedNontextLeaf = false): Style {
  const values: Record<string, string> = {};
  for (const key of STYLE_KEYS) if (node.attrs[key] !== undefined) values[key] = node.attrs[key]!;
  for (const field of (node.attrs.style ?? "").split(";")) {
    if (!field.trim()) continue;
    const colon = field.indexOf(":"); const key = field.slice(0, colon).trim(); const value = field.slice(colon + 1).trim();
    if (colon < 0 || !STYLE_KEYS.has(key)) unsupported("UNSUPPORTED_STYLE", node.index);
    values[key] = value;
  }
  const color = (value: string): string => /^(?:none|black|white|#[0-9a-f]{3}|#[0-9a-f]{6})$/iu.test(value) ? value.toLowerCase() : unsupported("UNSUPPORTED_PAINT", node.index);
  const opacity = (key: string, fallback: number): number => {
    if (values[key] === undefined) return fallback; const value = number(values[key], node.index);
    return value >= 0 && value <= 1 ? value : unsupported("UNSUPPORTED_OPACITY", node.index);
  };
  const width = values["stroke-width"] === undefined ? inherited.width : number(values["stroke-width"], node.index);
  if (width < 0) unsupported("NEGATIVE_STROKE_WIDTH", node.index);
  if (values["fill-rule"] !== undefined && values["fill-rule"] !== "nonzero"
      && !(omittedNontextLeaf && values["fill-rule"] === "evenodd")) unsupported("UNSUPPORTED_FILL_RULE", node.index);
  return {
    fill: color(values.fill ?? inherited.fill), stroke: color(values.stroke ?? inherited.stroke), width,
    opacity: inherited.opacity * opacity("opacity", 1), fillOpacity: opacity("fill-opacity", inherited.fillOpacity),
    strokeOpacity: opacity("stroke-opacity", inherited.strokeOpacity), cap: values["stroke-linecap"] ?? inherited.cap, join: values["stroke-linejoin"] ?? inherited.join,
  };
}
interface TextGroup { readonly index: number; readonly elementIndex: number; readonly text: string }
interface Primitive {
  readonly object: SchematicInkObject; readonly radius: number;
  readonly shape: { readonly kind: "segment"; readonly a: Point; readonly b: Point }
    | { readonly kind: "disk" | "ring"; readonly center: Point; readonly radius: number }
    | { readonly kind: "box"; readonly min: Point; readonly max: Point };
  readonly bounds: readonly [number, number, number, number];
}
const point = (x: number, y: number): Point => ({ x, y });
function pathSegments(value: string | undefined, index: number): readonly [Point, Point][] {
  if (value === undefined) unsupported("MISSING_PATH", index);
  const tokens: string[] = []; const pattern = /\s*,?\s*([MLZ]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/gy; let cursor = 0;
  while (cursor < value.length && value.slice(cursor).trim()) {
    pattern.lastIndex = cursor; const match = pattern.exec(value);
    if (!match) unsupported("UNSUPPORTED_PATH_COMMAND", index); tokens.push(match[1]!); cursor = pattern.lastIndex;
  }
  const segments: [Point, Point][] = []; let current: Point | undefined; let start: Point | undefined; let mode: string | undefined;
  for (let i = 0; i < tokens.length;) {
    if (/^[MLZ]$/u.test(tokens[i]!)) mode = tokens[i++];
    if (mode === "Z") { if (!current || !start) unsupported("MALFORMED_PATH", index); segments.push([current, start]); current = start; mode = undefined; continue; }
    if ((mode !== "M" && mode !== "L") || i + 1 >= tokens.length) unsupported("MALFORMED_PATH", index);
    const next = point(number(tokens[i++], index), number(tokens[i++], index));
    if (mode === "M") { start = next; mode = "L"; } else { if (!current) unsupported("MALFORMED_PATH", index); segments.push([current, next]); }
    current = next;
    if (segments.length > SCHEMATIC_RENDER_CLEARANCE_POLICY.maxSegments) unsupported("SVG_PRIMITIVE_LIMIT", index);
  }
  if (segments.length === 0) unsupported("EMPTY_VISIBLE_PATH", index);
  return segments;
}

/** KiCad rotates only this invisible metadata text. Its following stroked-text
 * sibling already contains absolute sheet coordinates; never rotate that ink.
 */
const metadataNumber = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const metadataRotation = new RegExp(`^\\s*rotate\\s*\\(\\s*(${metadataNumber})(?:\\s*,\\s*|\\s+)(${metadataNumber})(?:\\s*,\\s*|\\s+)(${metadataNumber})\\s*\\)\\s*$`, "u");
function rotatedNativeMetadataText(node: XmlNode): XmlNode | undefined {
  if (node.name !== "g" || Object.keys(node.attrs).length !== 1 || node.attrs.transform === undefined
      || node.children.length !== 1 || node.text.trim()) return undefined;
  const text = node.children[0]!;
  if (text.name !== "text" || text.children.length !== 0 || !text.text.trim()
      || text.attrs.opacity === undefined || text.attrs["stroke-opacity"] === undefined
      || number(text.attrs.opacity, text.index) !== 0 || number(text.attrs["stroke-opacity"], text.index) !== 0) return undefined;
  const match = metadataRotation.exec(node.attrs.transform);
  if (match === null) return undefined;
  const args = match.slice(1).map(value => number(value, node.index));
  return [-360, -270, -180, -90, 0, 90, 180, 270, 360].includes(args[0]!) ? text : undefined;
}

function collect(root: XmlNode, textOnly = false): { primitives: Primitive[]; groups: TextGroup[]; problems: SchematicInkUnsupported[] } {
  const primitives: Primitive[] = []; const groups: TextGroup[] = []; const problems: SchematicInkUnsupported[] = [];
  const rotatedMetadata = new Map<number, XmlNode>();
  const textGroupIndices = new Map<number, number>();
  const inventory = (node: XmlNode): void => {
    if (node.name === "g" && node.attrs.class === "stroked-text") textGroupIndices.set(node.index, textGroupIndices.size);
    for (const child of node.children) inventory(child);
  };
  inventory(root);
  if (textGroupIndices.size > SCHEMATIC_RENDER_CLEARANCE_POLICY.maxTextGroups) return { primitives, groups, problems: [{ code: "SVG_TEXT_GROUP_LIMIT", elementIndex: null }] };
  const issue = (error: unknown, index: number): void => { const failure = error instanceof UnsupportedSvg ? error : new UnsupportedSvg("MALFORMED_SVG_GEOMETRY", index); problems.push({ code: failure.code, elementIndex: failure.elementIndex ?? index }); };
  const add = (shape: Primitive["shape"], radius: number, node: XmlNode, group: TextGroup | null): void => {
    if (primitives.length >= SCHEMATIC_RENDER_CLEARANCE_POLICY.maxSegments) unsupported("SVG_PRIMITIVE_LIMIT", node.index);
    const min = shape.kind === "segment" ? point(Math.min(shape.a.x, shape.b.x), Math.min(shape.a.y, shape.b.y)) : shape.kind === "box" ? shape.min : point(shape.center.x - shape.radius, shape.center.y - shape.radius);
    const max = shape.kind === "segment" ? point(Math.max(shape.a.x, shape.b.x), Math.max(shape.a.y, shape.b.y)) : shape.kind === "box" ? shape.max : point(shape.center.x + shape.radius, shape.center.y + shape.radius);
    primitives.push({ object: { elementIndex: node.index, textGroupIndex: group?.index ?? null, text: group?.text ?? null }, shape, radius, bounds: [min.x - radius, min.y - radius, max.x + radius, max.y + radius] });
  };
  const baseAttributes = ["id", "style", "transform", ...STYLE_KEYS];
  const allowed: Record<string, readonly string[]> = {
    svg: ["version", "width", "height", "viewBox"], g: ["class"], title: [], desc: [],
    text: ["x", "y", "textLength", "font-size", "lengthAdjust", "text-anchor"], path: ["d"],
    rect: ["x", "y", "width", "height", "rx", "ry"], circle: ["cx", "cy", "r"],
  };
  const visit = (node: XmlNode, inherited: Style, owner: TextGroup | null, previous: XmlNode | undefined): void => {
    try {
      if (!Object.hasOwn(allowed, node.name)) unsupported("UNSUPPORTED_ELEMENT", node.index);
      if ((node.name === "title" || node.name === "desc") && node.children.length !== 0) unsupported("METADATA_CONTAINS_ELEMENTS", node.index);
      for (const key of Object.keys(node.attrs)) if (!baseAttributes.includes(key) && !allowed[node.name]!.includes(key) && !(node.name === "svg" && /^xmlns(?::[\w-]+)?$/u.test(key))) unsupported("UNSUPPORTED_ATTRIBUTE", node.index);
      const metadataText = rotatedNativeMetadataText(node);
      const transform = node.attrs.transform;
      if (transform !== undefined && metadataText === undefined) {
        let cursor = 0; const pattern = /\s*(translate|scale|matrix)\s*\(([^)]*)\)\s*/gy;
        while (cursor < transform.length) {
          pattern.lastIndex = cursor; const operation = pattern.exec(transform);
          if (!operation) unsupported("UNSUPPORTED_TRANSFORM", node.index);
          const args = operation[2]!.trim().split(/[\s,]+/u).map((entry) => number(entry, node.index));
          const expected = operation[1] === "matrix" ? [1, 0, 0, 1, 0, 0] : operation[1] === "translate" ? [0, 0] : [1, 1];
          if (args.length !== expected.length || args.some((entry, index) => entry !== expected[index])) unsupported("UNSUPPORTED_TRANSFORM", node.index);
          cursor = pattern.lastIndex;
        }
      }
      if (node.name === "svg") {
        if (node !== root) unsupported("NESTED_SVG_VIEWPORT_UNSUPPORTED", node.index);
        if (node.attrs.xmlns !== "http://www.w3.org/2000/svg") unsupported("UNSUPPORTED_SVG_NAMESPACE", node.index);
        const box = node.attrs.viewBox?.trim().split(/[\s,]+/u).map((item) => number(item, node.index));
        if (!box || box.length !== 4 || box[0] !== 0 || box[1] !== 0 || box[2]! <= 0 || box[3]! <= 0 || !node.attrs.width?.endsWith("mm") || !node.attrs.height?.endsWith("mm") || number(node.attrs.width.slice(0, -2), node.index) !== box[2] || number(node.attrs.height.slice(0, -2), node.index) !== box[3]) unsupported("UNSUPPORTED_SVG_UNITS_OR_VIEWPORT", node.index);
      }
      const omittedNontextLeaf = textOnly && owner === null && ["path", "rect", "circle"].includes(node.name)
        && node.children.length === 0 && !node.text.trim();
      const style = styleFor(node, inherited, omittedNontextLeaf); let group = owner;
      if (metadataText !== undefined) rotatedMetadata.set(node.index, metadataText);
      if (node.name === "g" && node.attrs.class !== undefined) {
        if (node.attrs.class !== "stroked-text" || owner !== null || groups.length >= SCHEMATIC_RENDER_CLEARANCE_POLICY.maxTextGroups) unsupported("UNSUPPORTED_TEXT_GROUP", node.index);
        const descriptions = node.children.filter((child) => child.name === "desc");
        const precedingText = previous?.name === "text" ? previous : previous === undefined ? undefined : rotatedMetadata.get(previous.index);
        if (descriptions.length !== 1 || precedingText === undefined || precedingText.text !== descriptions[0]!.text
            || !precedingText.text.trim() || precedingText.children.length) unsupported("UNPAIRED_NATIVE_TEXT_GROUP", node.index);
        group = { index: textGroupIndices.get(node.index)!, elementIndex: node.index, text: precedingText.text }; groups.push(group);
      }
      if (node.name === "text") {
        if (style.opacity !== 0) unsupported("VISIBLE_FONT_TEXT_UNSUPPORTED", node.index);
      } else if (node.name === "path" || node.name === "rect" || node.name === "circle") {
        if (node.children.length || node.text.trim()) unsupported("SHAPE_HAS_CHILD_CONTENT", node.index);
        // Planning text coverage is independent of source-qualified symbol
        // graphics. Still validate every container/transform/style above; only
        // nontext leaf geometry (including native arcs) is outside this scope.
        if (textOnly && owner === null) return;
        const stroke = style.opacity > 0 && style.stroke !== "none" && style.strokeOpacity > 0 && style.width > 0;
        const fill = style.opacity > 0 && style.fill !== "none" && style.fillOpacity > 0;
        const black = (paint: string): boolean => ["black", "#000", "#000000"].includes(paint);
        if (stroke && !black(style.stroke) || fill && !black(style.fill)) unsupported("UNSUPPORTED_NONBLACK_PAINT_OR_OCCLUSION", node.index);
        if (stroke && (style.cap !== "round" || style.join !== "round")) unsupported("UNSUPPORTED_STROKE_CAP_OR_JOIN", node.index);
        if (owner !== null && node.name !== "path") unsupported("UNSUPPORTED_GLYPH_PRIMITIVE", node.index);
        if (node.name === "path") {
          if (fill) unsupported("FILLED_PATH_UNSUPPORTED", node.index);
          if (stroke) for (const [a, b] of pathSegments(node.attrs.d, node.index)) add({ kind: "segment", a, b }, style.width / 2, node, group);
        } else if (node.name === "rect") {
          const x = number(node.attrs.x, node.index), y = number(node.attrs.y, node.index), w = number(node.attrs.width, node.index), h = number(node.attrs.height, node.index);
          if (w < 0 || h < 0 || number(node.attrs.rx ?? "0", node.index) !== 0 || number(node.attrs.ry ?? "0", node.index) !== 0) unsupported("UNSUPPORTED_RECTANGLE", node.index);
          const a = point(x, y), b = point(x + w, y), c = point(x + w, y + h), d = point(x, y + h);
          if (fill) add({ kind: "box", min: a, max: c }, 0, node, group);
          if (stroke) for (const [first, last] of [[a, b], [b, c], [c, d], [d, a]] as const) add({ kind: "segment", a: first, b: last }, style.width / 2, node, group);
        } else {
          const center = point(number(node.attrs.cx, node.index), number(node.attrs.cy, node.index)); const radius = number(node.attrs.r, node.index);
          if (radius < 0) unsupported("NEGATIVE_CIRCLE_RADIUS", node.index);
          if (fill) add({ kind: "disk", center, radius }, 0, node, group);
          if (stroke) add({ kind: "ring", center, radius }, style.width / 2, node, group);
        }
      }
      for (let i = 0; i < node.children.length; i++) visit(node.children[i]!, style, group, node.children[i - 1]);
      if (node.name === "g" && group !== owner && !primitives.some((entry) => entry.object.textGroupIndex === group!.index)) unsupported("EMPTY_NATIVE_TEXT_GROUP", node.index);
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!;
        if (child === metadataText) continue; // Its required paired ink is the wrapper's next sibling.
        if ((child.name === "text" || rotatedMetadata.has(child.index)) && node.children[i + 1]?.attrs.class !== "stroked-text") {
          problems.push({ code: "NATIVE_TEXT_WITHOUT_GLYPH_GROUP", elementIndex: child.index });
        }
      }
    } catch (error) { issue(error, node.index); }
  };
  visit(root, DEFAULT_STYLE, null, undefined);
  if (primitives.length > 0) {
    const viewport = root.attrs.viewBox?.trim().split(/[\s,]+/u).map(Number);
    if (viewport?.length === 4 && primitives.some((entry) => entry.bounds[0] < 0 || entry.bounds[1] < 0 || entry.bounds[2] > viewport[2]! || entry.bounds[3] > viewport[3]!)) problems.push({ code: "INK_OUTSIDE_NATIVE_VIEWPORT", elementIndex: null });
  }
  if (!groups.length || !primitives.some((entry) => entry.object.textGroupIndex !== null)) problems.push({ code: "NO_NATIVE_GLYPH_COVERAGE", elementIndex: null });
  return { primitives, groups, problems };
}

/** Complete native glyph envelopes, with no inferred schematic ownership. */
export function collectNativeSchematicTextBounds(source: string) {
  let primitives: Primitive[] = [], groups: TextGroup[] = [], problems: SchematicInkUnsupported[] = [];
  try {
    if (typeof source !== "string" || !source.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source)
        || Buffer.byteLength(source, "utf8") > SCHEMATIC_RENDER_CLEARANCE_POLICY.maxSvgBytes) unsupported("SVG_BYTE_LIMIT_OR_INVALID_UNICODE");
    ({ primitives, groups, problems } = collect(parseXml(source), true));
  } catch (error) { problems.push({ code: error instanceof UnsupportedSvg ? error.code : "MALFORMED_SVG", elementIndex: error instanceof UnsupportedSvg ? error.elementIndex : null }); }
  const bounds = groups.flatMap(group => {
    const glyphs = primitives.filter(primitive => primitive.object.textGroupIndex === group.index);
    return glyphs.length === 0 ? [] : [{ textGroupIndex: group.index, elementIndex: group.elementIndex, text: group.text,
      minX: Math.min(...glyphs.map(glyph => glyph.bounds[0])), minY: Math.min(...glyphs.map(glyph => glyph.bounds[1])),
      maxX: Math.max(...glyphs.map(glyph => glyph.bounds[2])), maxY: Math.max(...glyphs.map(glyph => glyph.bounds[3])) }];
  });
  return freeze({ completeCoverage: problems.length === 0, hasText: /<text(?:\s|>)/u.test(source) || source.includes("stroked-text"), bounds, unsupported: problems });
}

const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const subtract = (a: Point, b: Point): Point => point(a.x - b.x, a.y - b.y);
const magnitude = (a: Point): number => Math.hypot(a.x, a.y);
const closestPoint = (p: Point, a: Point, b: Point): Point => {
  const line = subtract(b, a); const length = dot(line, line); const t = length === 0 ? 0 : Math.max(0, Math.min(1, dot(subtract(p, a), line) / length));
  return point(a.x + t * line.x, a.y + t * line.y);
};
interface Distance { a: Point; b: Point; distance: number }
const pairDistance = (a: Point, b: Point): Distance => ({ a, b, distance: magnitude(subtract(a, b)) });
function segmentDistance(a: Point, b: Point, c: Point, d: Point): Distance {
  const ab = subtract(b, a), cd = subtract(d, c), ac = subtract(c, a); const cross = (x: Point, y: Point): number => x.x * y.y - x.y * y.x;
  const denominator = cross(ab, cd);
  if (denominator !== 0) {
    const t = cross(ac, cd) / denominator, u = cross(ac, ab) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { const hit = point(a.x + t * ab.x, a.y + t * ab.y); return { a: hit, b: hit, distance: 0 }; }
  }
  return [pairDistance(a, closestPoint(a, c, d)), pairDistance(b, closestPoint(b, c, d)), pairDistance(closestPoint(c, a, b), c), pairDistance(closestPoint(d, a, b), d)].sort((left, right) => left.distance - right.distance)[0]!;
}
function primitiveDistance(text: Primitive, other: Primitive): Distance {
  if (text.shape.kind !== "segment") throw new Error("Glyphs must be line segments");
  const { a, b } = text.shape; const shape = other.shape;
  if (shape.kind === "segment") return segmentDistance(a, b, shape.a, shape.b);
  if (shape.kind === "box") {
    const inside = (p: Point): boolean => p.x >= shape.min.x && p.x <= shape.max.x && p.y >= shape.min.y && p.y <= shape.max.y;
    if (inside(a) || inside(b)) { const p = inside(a) ? a : b; return { a: p, b: p, distance: 0 }; }
    const p = shape.min, q = point(shape.max.x, shape.min.y), r = shape.max, s = point(shape.min.x, shape.max.y);
    return [[p, q], [q, r], [r, s], [s, p]].map(([c, d]) => segmentDistance(a, b, c!, d!)).sort((x, y) => x.distance - y.distance)[0]!;
  }
  const nearest = closestPoint(shape.center, a, b); const min = magnitude(subtract(nearest, shape.center));
  if (shape.kind === "disk" && min <= shape.radius) return { a: nearest, b: nearest, distance: 0 };
  const farthest = magnitude(subtract(a, shape.center)) >= magnitude(subtract(b, shape.center)) ? a : b;
  const max = magnitude(subtract(farthest, shape.center));
  if (shape.kind === "ring" && min <= shape.radius && max >= shape.radius) {
    const direction = subtract(b, a), offset = subtract(a, shape.center); const aa = dot(direction, direction), bb = 2 * dot(offset, direction), cc = dot(offset, offset) - shape.radius ** 2;
    const discriminant = Math.max(0, bb * bb - 4 * aa * cc);
    const solutions = aa === 0 ? [0] : [(-bb - Math.sqrt(discriminant)) / (2 * aa), (-bb + Math.sqrt(discriminant)) / (2 * aa)];
    const t = solutions.find((value) => value >= 0 && value <= 1) ?? 0; const hit = point(a.x + t * direction.x, a.y + t * direction.y);
    return { a: hit, b: hit, distance: 0 };
  }
  const p = shape.kind === "ring" && max < shape.radius ? farthest : nearest; const delta = subtract(p, shape.center); const length = magnitude(delta);
  const edge = length === 0 ? point(shape.center.x + shape.radius, shape.center.y) : point(shape.center.x + delta.x * shape.radius / length, shape.center.y + delta.y * shape.radius / length);
  return pairDistance(p, edge);
}

export function analyzeNativeSchematicSvg(source: string): SchematicInkAnalysis {
  let primitives: Primitive[] = []; let groups: TextGroup[] = []; let problems: SchematicInkUnsupported[] = [];
  try {
    if (typeof source !== "string" || !source.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source) || Buffer.byteLength(source, "utf8") > SCHEMATIC_RENDER_CLEARANCE_POLICY.maxSvgBytes) unsupported("SVG_BYTE_LIMIT_OR_INVALID_UNICODE");
    ({ primitives, groups, problems } = collect(parseXml(source)));
  } catch (error) { problems.push({ code: error instanceof UnsupportedSvg ? error.code : "MALFORMED_SVG", elementIndex: error instanceof UnsupportedSvg ? error.elementIndex : null }); }
  const collisions = new Map<string, SchematicInkCollision>(); let comparisons = 0; let truncated = false;
  outer: for (let i = 0; i < primitives.length; i++) {
    const a = primitives[i]!; if (a.object.textGroupIndex === null) continue;
    for (let j = 0; j < primitives.length; j++) {
      const b = primitives[j]!;
      if (a.object.textGroupIndex === b.object.textGroupIndex || b.object.textGroupIndex !== null && b.object.textGroupIndex < a.object.textGroupIndex) continue;
      if (++comparisons > SCHEMATIC_RENDER_CLEARANCE_POLICY.maxComparisons) { problems.push({ code: "COLLISION_WORK_LIMIT", elementIndex: null }); break outer; }
      const tolerance = SCHEMATIC_RENDER_CLEARANCE_POLICY.numericalToleranceMm;
      if (a.bounds[2] + tolerance < b.bounds[0] || b.bounds[2] + tolerance < a.bounds[0] || a.bounds[3] + tolerance < b.bounds[1] || b.bounds[3] + tolerance < a.bounds[1]) continue;
      const distance = primitiveDistance(a, b); const gap = distance.distance - a.radius - b.radius;
      if (gap > SCHEMATIC_RENDER_CLEARANCE_POLICY.numericalToleranceMm) continue;
      const key = `${a.object.textGroupIndex}:${b.object.textGroupIndex === null ? `element-${b.object.elementIndex}` : `text-${b.object.textGroupIndex}`}`;
      const previous = collisions.get(key);
      if (previous !== undefined && previous.inkGapMm <= gap) continue;
      if (previous === undefined && collisions.size >= SCHEMATIC_RENDER_CLEARANCE_POLICY.maxWitnesses) { truncated = true; continue; }
      collisions.set(key, { kind: b.object.textGroupIndex === null ? "text-geometry" : "text-text", a: a.object, b: b.object, pointAMm: distance.a, pointBMm: distance.b, inkGapMm: gap });
    }
  }
  const uniqueProblems = [...new Map(problems.map((entry) => [`${entry.code}:${entry.elementIndex}`, entry])).values()];
  return freeze({ scope: "native-ink-clearance-only", status: collisions.size > 0 ? "fail" : uniqueProblems.length > 0 ? "unknown" : "pass", completeCoverage: uniqueProblems.length === 0,
    textGroupCount: groups.length, primitiveCount: primitives.length, comparisons, collisions: [...collisions.values()], witnessesTruncated: truncated, unsupported: uniqueProblems, limitations: LIMITATIONS });
}

const sources = (value: KicadSchematicSourceIdentities): KicadSchematicSourceIdentities => freeze({
  schematic: validateContentIdentity(value.schematic), pcb: validateContentIdentity(value.pcb), projectSettings: validateContentIdentity(value.projectSettings),
});
/** Host-only evidence: does not repair files or consume an iteration. Feed failures into the live repair loop. */
export function createSchematicRenderClearanceEvidence(capture: KicadSchematicSvgResult, expected: SchematicRenderClearanceExpected): SchematicRenderClearanceEvidence {
  const observedSources = sources(capture.sourceIdentities); const expectedSources = sources(expected.sources);
  const validationSourceBindingIdentity = validateCanonicalIdentity(expected.validationSourceBindingIdentity);
  if (validationSourceBindingIdentity.schemaVersion !== "evleda.pcb-harness-validation-source-binding.v1") throw new Error("Schematic clearance requires a current validation-source binding identity.");
  const executableIdentity = validateContentIdentity({ algorithm: "sha256", digest: capture.executable.sha256, size: capture.executable.sizeBytes });
  const expectedExecutable = validateContentIdentity({ algorithm: "sha256", digest: expected.executable.sha256, size: expected.executable.sizeBytes });
  const nativeSvgIdentity = contentIdentity(capture.source); const bindingProblems: string[] = [];
  if (canonicalJson(observedSources) !== canonicalJson(expectedSources)) bindingProblems.push("STALE_SOURCE_IDENTITIES");
  if (canonicalJson(executableIdentity) !== canonicalJson(expectedExecutable) || canonicalJson(capture.invocation.executable) !== canonicalJson(capture.executable)) bindingProblems.push("EXECUTABLE_IDENTITY_MISMATCH");
  if (nativeSvgIdentity.digest !== capture.schematicSvg.sha256 || nativeSvgIdentity.size !== capture.schematicSvg.sizeBytes) bindingProblems.push("SVG_ARTIFACT_IDENTITY_MISMATCH");
  if (capture.invocation.exitCode !== 0 || capture.invocation.args.slice(0, 3).join(" ") !== "sch export svg" || capture.classification !== "candidate-validation" || capture.releaseAuthorized !== false) bindingProblems.push("INVALID_NATIVE_SVG_INVOCATION");
  const analysis = analyzeNativeSchematicSvg(capture.source);
  const payload = {
    schemaVersion: SCHEMATIC_RENDER_CLEARANCE_SCHEMA_VERSION, ...analysis,
    ...(bindingProblems.length === 0 ? {} : { status: "unknown" as const, completeCoverage: false }),
    policyIdentity: SCHEMATIC_RENDER_CLEARANCE_POLICY_IDENTITY, sources: observedSources,
    sourceSetIdentity: canonicalIdentity(capture.sourceHashes, "evleda.kicad-source-set.v1"), validationSourceBindingIdentity, executableIdentity,
    invocationIdentity: canonicalIdentity(capture.invocation, "evleda.kicad-schematic-svg-invocation.v1"), nativeSvgIdentity, bindingProblems,
  };
  const receipt = freeze({ ...payload, identity: canonicalIdentity(payload, SCHEMATIC_RENDER_CLEARANCE_SCHEMA_VERSION) });
  hostReceipts.add(receipt);
  return receipt;
}

/** In-process provenance for synchronous acceptance; a copied or reminted JSON receipt is not fresh host authority. */
export function verifyHostSchematicRenderClearanceEvidence(evidence: unknown, expected: SchematicRenderClearanceExpected): SchematicRenderClearanceEvidence {
  if (evidence === null || typeof evidence !== "object" || !hostReceipts.has(evidence)) throw new Error("Schematic clearance evidence was not generated by the current host collector.");
  const receipt = evidence as SchematicRenderClearanceEvidence;
  const tool = validateContentIdentity({ algorithm: "sha256", digest: expected.executable.sha256, size: expected.executable.sizeBytes });
  if (canonicalJson(receipt.sources) !== canonicalJson(sources(expected.sources)) || canonicalJson(receipt.executableIdentity) !== canonicalJson(tool)
      || canonicalJson(receipt.validationSourceBindingIdentity) !== canonicalJson(validateCanonicalIdentity(expected.validationSourceBindingIdentity))) throw new Error("Schematic clearance evidence does not bind the current sources, tool, and validation pass.");
  return receipt;
}

/** Recompute from the same immutable SVG and current expected bindings; never trust a saved PASS bit. */
export function verifySchematicRenderClearanceEvidence(evidence: unknown, capture: KicadSchematicSvgResult, expected: SchematicRenderClearanceExpected): SchematicRenderClearanceEvidence {
  const reproduced = createSchematicRenderClearanceEvidence(capture, expected);
  if (canonicalJson(evidence) !== canonicalJson(reproduced)) throw new Error("Schematic render-clearance evidence does not reproduce from the exact native SVG and current source bindings.");
  return reproduced;
}

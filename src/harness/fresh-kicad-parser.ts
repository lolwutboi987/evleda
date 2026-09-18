import { createHash } from "node:crypto";
import type { ContentIdentity } from "../domain/types.js";
import { physicalPadDefinitionKey } from "./fresh-pcb-pad-model.js";
import { freshBoardComparisonText, freshBoardSerializationsEqual } from "./fresh-board-serialization.js";

/**
 * Small, bounded KiCad S-expression reader for the closed fresh-design gate.
 * It intentionally extracts only facts absent from the practice analyzer.
 */

export interface FreshPoint { readonly x: number; readonly y: number }

interface SourceSpan { readonly start: number; readonly end: number }
interface Atom extends SourceSpan { readonly value: string; readonly quoted: boolean }
interface Node extends SourceSpan { readonly name: string; readonly values: readonly Atom[]; readonly children: readonly Node[] }

/** Read-only source locations for narrowly scoped, lossless PCB token edits. */
export type FreshKicadSourceNode = Node;
export type FreshKicadSourceAtom = Atom;

export interface FreshSchematicSymbol {
  readonly reference: string;
  readonly libId: string;
  readonly value: string;
  readonly footprint: string;
}

export interface FreshSchematicWire {
  readonly start: FreshPoint;
  readonly end: FreshPoint;
}

export interface FreshSchematicLabel {
  readonly name: string;
  readonly at: FreshPoint;
  readonly kind: "local" | "global" | "hierarchical";
  /** Local labels have no electrical shape. Preserve the exact serialized shape otherwise. */
  readonly shape: string | null;
}

export type FreshSchematicJustification = "left" | "right" | "top" | "bottom" | "mirror";

export interface FreshSchematicTextPresentation {
  readonly at: FreshPoint | null;
  readonly rotationDeg: number | null;
  /** Explicit source tokens in their original order; null means no justify form. */
  readonly justify: readonly FreshSchematicJustification[] | null;
  /** First/second serialized font-size values; not a measured text extent. */
  readonly fontSizeMm: FreshPoint | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly hidden: boolean;
  readonly origins: Readonly<{
    at: "explicit" | "omitted";
    rotationDeg: "explicit" | "omitted";
    justify: "explicit" | "omitted";
    fontSizeMm: "explicit" | "omitted";
    bold: "explicit" | "omitted-default";
    italic: "explicit" | "omitted-default";
    hidden: "explicit" | "omitted-default";
  }>;
}

export interface FreshSchematicPresentationLabel extends FreshSchematicTextPresentation {
  readonly name: string;
  readonly kind: FreshSchematicLabel["kind"];
  readonly shape: string | null;
  readonly at: FreshPoint;
}

export interface FreshSchematicPresentationField extends FreshSchematicTextPresentation {
  readonly kind: "Reference" | "Value";
  readonly text: string | null;
  readonly sourcePresent: boolean;
  readonly reference: string | null;
  /** Zero-based root-instance order; no association to library-definition fields is inferred. */
  readonly symbolIndex: number;
  readonly symbolUuid: string | null;
}

export interface FreshSchematicPresentationSource {
  readonly version: number | null;
  readonly labels: readonly FreshSchematicPresentationLabel[];
  readonly symbolFields: readonly FreshSchematicPresentationField[];
}

export interface FreshSchematicPresentationFieldTarget {
  readonly symbolIndex: number;
  readonly kind: "Reference" | "Value";
}

export interface FreshSchematicFieldPresentationComparison {
  readonly equal: boolean;
  /** Target fields whose position/angle or positional-justify selection changed. */
  readonly changedFieldCount: number;
}

export interface FreshSchematicClassSources {
  /** Exact native canonical Netclass and its English compatibility alias. */
  readonly netclassPropertyCount: number;
  /** Other label fields outside the generated model's intersheet-only metadata. */
  readonly unsupportedLabelPropertyCount: number;
  /** Includes the historical netclass_flag form still accepted by KiCad 10. */
  readonly directiveLabelCount: number;
  readonly ruleAreaCount: number;
}

export interface FreshNetlistNode {
  readonly reference: string;
  readonly pin: string;
  readonly pinType: string;
}

export interface FreshNetlistComponent {
  readonly reference: string;
  readonly symbolLibId: string;
  readonly value: string;
  readonly footprintLibId: string;
}

export interface FreshNetlistNet {
  readonly name: string;
  readonly nodes: readonly FreshNetlistNode[];
}

export interface FreshPcbPad {
  readonly number: string;
  readonly at: FreshPoint;
  readonly netName: string | null;
  /** Exact serialized KiCad layer selectors, in file order. */
  readonly layers: readonly string[];
  /** Separate physical facts; absent legacy identity/geometry is explicit, never inferred. */
  readonly physical: Readonly<{
    readonly id: string | null;
    readonly padType: string | null;
    readonly shape: string | null;
    readonly relativeAt: FreshPoint;
    /** Serialized pad angle is already absolute board orientation. */
    readonly rotationDeg: number;
    readonly sizeMm: FreshPoint | null;
    readonly roundrectRatio: number | null;
    readonly drill: Readonly<{ readonly shape: "circle" | "oval"; readonly sizeMm: FreshPoint; readonly offsetMm: FreshPoint | null }> | null;
    /** Exact complete pad form, preserving paste, mask, drill, shape and unknown fields. */
    readonly source: string;
    readonly definitionKey: string;
  }>;
}

export interface FreshPcbFootprint {
  readonly id: string | null;
  readonly reference: string;
  readonly libraryId: string;
  readonly value: string;
  readonly layer: string;
  readonly at: FreshPoint;
  readonly rotationDeg: number;
  readonly courtyardBounds: FreshBounds | null;
  readonly bodyBounds: FreshBounds | null;
  readonly pads: readonly FreshPcbPad[];
}

export interface FreshPcbSegment {
  readonly id: string | null;
  readonly start: FreshPoint;
  readonly end: FreshPoint;
  readonly widthMm: number;
  readonly layer: string;
  readonly netName: string | null;
}

export interface FreshPcbVia {
  readonly id: string | null;
  readonly at: FreshPoint;
  readonly diameterMm: number;
  readonly drillMm: number;
  readonly layers: readonly string[];
  readonly netName: string | null;
}

export interface FreshBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface FreshParsedPcb {
  readonly version: number | null;
  readonly footprints: readonly FreshPcbFootprint[];
  readonly segments: readonly FreshPcbSegment[];
  readonly vias: readonly FreshPcbVia[];
  readonly viaCount: number;
  readonly zoneNetNames: readonly string[];
  readonly outlineBounds: FreshBounds | null;
  readonly outlineSupported: boolean;
}

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const MAX_SOURCE = 64 * 1024 * 1024;
const MAX_NODES = 1_000_000;
const MAX_DEPTH = 256;
const MAX_TOKEN = 1_048_576;

export class FreshKicadParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreshKicadParseError";
  }
}

function parseDocument(source: string, expectedRoot: string, rawTokens?: SourceSpan[]): Node {
  if (source.length === 0 || source.length > MAX_SOURCE) throw new FreshKicadParseError("KiCad source size is unsupported.");
  let cursor = 0;
  let count = 0;
  const recordToken = (start: number, end: number): void => {
    if (rawTokens === undefined) return;
    if (rawTokens.length >= MAX_NODES) throw new FreshKicadParseError("KiCad raw token count is unsupported.");
    rawTokens.push({ start, end });
  };
  const whitespace = (): void => { while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1; };
  const atom = (): Atom => {
    const start = cursor;
    if (source[cursor] === '"') {
      cursor += 1;
      let value = "";
      while (cursor < source.length) {
        const character = source[cursor++]!;
        if (character === '"') { recordToken(start, cursor); return { value, quoted: true, start, end: cursor }; }
        if (character === "\\") {
          if (cursor >= source.length) throw new FreshKicadParseError("Unterminated KiCad string escape.");
          const escaped = source[cursor++]!;
          value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
        } else value += character;
        if (value.length > MAX_TOKEN) throw new FreshKicadParseError("KiCad token is too long.");
      }
      throw new FreshKicadParseError("Unterminated KiCad string.");
    }
    while (cursor < source.length && !/[\s()]/u.test(source[cursor]!)) {
      cursor += 1;
      if (cursor - start > MAX_TOKEN) throw new FreshKicadParseError("KiCad token is too long.");
    }
    if (cursor === start) throw new FreshKicadParseError("Expected KiCad atom.");
    recordToken(start, cursor);
    return { value: source.slice(start, cursor), quoted: false, start, end: cursor };
  };
  const node = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new FreshKicadParseError("KiCad nesting is unsupported.");
    if (source[cursor] !== "(") throw new FreshKicadParseError("Expected KiCad form.");
    const start = cursor;
    recordToken(cursor, cursor + 1);
    cursor += 1;
    whitespace();
    if (source[cursor] === "(" || source[cursor] === ")" || cursor >= source.length) throw new FreshKicadParseError("KiCad form has no name.");
    const head = atom();
    if (head.quoted) throw new FreshKicadParseError("KiCad form name cannot be quoted.");
    count += 1;
    if (count > MAX_NODES) throw new FreshKicadParseError("KiCad form count is unsupported.");
    const values: Atom[] = [];
    const children: Node[] = [];
    while (true) {
      whitespace();
      if (cursor >= source.length) throw new FreshKicadParseError(`Unterminated ${head.value} form.`);
      if (source[cursor] === ")") { recordToken(cursor, cursor + 1); cursor += 1; return { name: head.value, values, children, start, end: cursor }; }
      if (source[cursor] === "(") children.push(node(depth + 1));
      else values.push(atom());
    }
  };
  whitespace();
  const root = node(1);
  whitespace();
  if (cursor !== source.length || root.name !== expectedRoot || root.values.length !== 0) {
    throw new FreshKicadParseError(`Expected one ${expectedRoot} root form.`);
  }
  return root;
}

const children = (node: Node, name: string): readonly Node[] => node.children.filter((child) => child.name === name);

/** Reuse the bounded reader without projecting away unknown PCB source forms. */
export function parseFreshPcbSourceDocument(source: string): FreshKicadSourceNode {
  return parseDocument(source, "kicad_pcb");
}
const one = (node: Node, name: string): Node | null => children(node, name).length === 1 ? children(node, name)[0]! : null;
const scalar = (node: Node, name: string): string | null => {
  const child = one(node, name);
  return child !== null && child.children.length === 0 && child.values.length === 1 ? child.values[0]!.value : null;
};
const itemIdentity = (node: Node, label: string): string | null => {
  const fields = node.children.filter((child) => child.name === "uuid" || child.name === "tstamp");
  if (fields.length === 0) return null;
  if (fields.length !== 1 || fields[0]!.children.length !== 0 || fields[0]!.values.length !== 1
      || fields[0]!.values[0]!.value.length === 0) {
    throw new FreshKicadParseError(`${label} has missing, multiple, or malformed uuid/tstamp identity fields.`);
  }
  return fields[0]!.values[0]!.value;
};
const number = (value: string | undefined): number | null => {
  if (value === undefined || !NUMBER.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 10_000_000 ? parsed : null;
};
const versionNumber = (value: string | null): number | null => {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const point = (node: Node, name: string): FreshPoint | null => {
  const field = one(node, name);
  const x = number(field?.values[0]?.value);
  const y = number(field?.values[1]?.value);
  return field !== null && field.children.length === 0 && x !== null && y !== null ? { x, y } : null;
};
const property = (node: Node, name: string): string | null => {
  const matches = children(node, "property").filter((entry) => entry.values[0]?.value === name && entry.values.length >= 2);
  return matches.length === 1 ? matches[0]!.values[1]!.value : null;
};

const descendants = (node: Node, name: string): readonly Node[] => node.children.flatMap((child) => [
  ...(child.name === name ? [child] : []),
  ...descendants(child, name),
]);

/** Exact cardinal pin orientations from the embedded symbol definition used by the placed unit. */
export function parseFreshEmbeddedPinAngles(
  source: string,
  libraryId: string,
  unit: number,
): Readonly<Record<string, 0 | 90 | 180 | 270>> {
  if (!Number.isSafeInteger(unit) || unit < 1) throw new FreshKicadParseError("Embedded pin-angle unit must be a positive integer.");
  const root = parseDocument(source, "kicad_sch");
  const library = one(root, "lib_symbols");
  if (library === null) throw new FreshKicadParseError("Schematic must contain exactly one lib_symbols form.");
  const definitions = children(library, "symbol").filter((symbol) => symbol.values[0]?.value === libraryId);
  if (definitions.length !== 1) throw new FreshKicadParseError(`Expected exactly one embedded ${libraryId} definition.`);
  const definition = definitions[0]!;
  const symbolName = libraryId.slice(libraryId.indexOf(":") + 1);
  const candidates = [definition, ...descendants(definition, "symbol")].filter((symbol) => {
    if (symbol === definition) return true;
    const name = symbol.values[0]?.value ?? "";
    return name.startsWith(`${symbolName}_${unit}_`) || name.startsWith(`${symbolName}_0_`);
  });
  const angles = new Map<string, 0 | 90 | 180 | 270>();
  for (const candidate of candidates) for (const pin of children(candidate, "pin")) {
    const numberFields = children(pin, "number");
    const atFields = children(pin, "at");
    const pinNumber = numberFields.length === 1 ? numberFields[0]!.values[0]?.value : undefined;
    const angle = atFields.length === 1 ? number(atFields[0]!.values[2]?.value) : null;
    if (pinNumber === undefined || pinNumber.length === 0 || angle === null || ![0, 90, 180, 270].includes(angle)) {
      throw new FreshKicadParseError(`Embedded ${libraryId} pin metadata lacks an exact cardinal number/angle.`);
    }
    const cardinal = angle as 0 | 90 | 180 | 270;
    const previous = angles.get(pinNumber);
    if (previous !== undefined && previous !== cardinal) throw new FreshKicadParseError(`Embedded ${libraryId} pin ${pinNumber} has conflicting angles.`);
    angles.set(pinNumber, cardinal);
  }
  if (angles.size === 0) throw new FreshKicadParseError(`Embedded ${libraryId} unit ${unit} exposes no exact pin angles.`);
  return Object.freeze(Object.fromEntries([...angles].sort(([left], [right]) => left.localeCompare(right, "en-US")))) as Readonly<Record<string, 0 | 90 | 180 | 270>>;
}

export function parseFreshSchematicSource(source: string): Readonly<{
  version: number | null;
  symbols: readonly FreshSchematicSymbol[];
  noConnectCount: number;
  noConnects: readonly FreshPoint[];
  wires: readonly FreshSchematicWire[];
  labels: readonly FreshSchematicLabel[];
  junctions: readonly FreshPoint[];
  /** Actual root child-sheet forms; sheet_instances metadata is not a child sheet. */
  childSheetCount: number;
  classSources: FreshSchematicClassSources;
}> {
  const root = parseDocument(source, "kicad_sch");
  const version = versionNumber(scalar(root, "version"));
  const symbols = children(root, "symbol").map((symbol, index): FreshSchematicSymbol => {
    const reference = property(symbol, "Reference");
    const libId = scalar(symbol, "lib_id");
    const value = property(symbol, "Value");
    const footprint = property(symbol, "Footprint");
    if ([reference, libId, value, footprint].some((entry) => entry === null)) {
      throw new FreshKicadParseError(`Schematic symbol ${index + 1} lacks an exact identity field.`);
    }
    return { reference: reference!, libId: libId!, value: value!, footprint: footprint! };
  });
  const noConnects = children(root, "no_connect").map((entry, index) => {
    const position = point(entry, "at");
    if (position === null) throw new FreshKicadParseError(`Schematic no-connect ${index + 1} lacks an exact position.`);
    return position;
  });
  const wires = children(root, "wire").map((wire, index): FreshSchematicWire => {
    const points = one(wire, "pts");
    const coordinates = points === null ? [] : children(points, "xy").map((entry) => {
      const x = number(entry.values[0]?.value);
      const y = number(entry.values[1]?.value);
      return entry.children.length === 0 && x !== null && y !== null ? { x, y } : null;
    });
    if (coordinates.length !== 2 || coordinates.some((entry) => entry === null)) throw new FreshKicadParseError(`Schematic wire ${index + 1} lacks exactly two finite points.`);
    return { start: coordinates[0]!, end: coordinates[1]! };
  });
  const labelKinds = { label: "local", global_label: "global", hierarchical_label: "hierarchical" } as const;
  let netclassPropertyCount = 0;
  let unsupportedLabelPropertyCount = 0;
  const directiveLabelCount = children(root, "directive_label").length + children(root, "netclass_flag").length;
  for (const label of root.children.filter((entry) => Object.hasOwn(labelKinds, entry.name)
      || entry.name === "directive_label" || entry.name === "netclass_flag")) {
    for (const field of children(label, "property")) {
      // Native parseSchField permits an unquoted `private` modifier before the
      // name; it does not prevent the field from assigning a net class.
      const offset = field.values[0]?.value === "private" && !field.values[0]!.quoted ? 1 : 0;
      const name = field.values[offset]?.value;
      if (name === "Netclass" || name === "Net Class") netclassPropertyCount += 1;
      else {
        // KiCad matches both spellings case-insensitively on global labels.
        // All other label properties are outside this closed generated model:
        // localized Net Class aliases must not depend on the host's locale.
        const intersheet = name !== undefined && ["intersheetrefs", "intersheet references"].includes(name.toLowerCase());
        if (label.name !== "global_label" || !intersheet || field.values.length !== offset + 2) {
          unsupportedLabelPropertyCount += 1;
        }
      }
    }
  }
  const labels = root.children.filter((entry) => Object.hasOwn(labelKinds, entry.name)).map((label, index): FreshSchematicLabel => {
    const position = point(label, "at");
    const name = label.values.length === 1 ? label.values[0]!.value : null;
    if (position === null || name === null || name.length === 0) throw new FreshKicadParseError(`Schematic label ${index + 1} lacks an exact name or position.`);
    const kind = labelKinds[label.name as keyof typeof labelKinds];
    const shapeFields = children(label, "shape");
    const shape = scalar(label, "shape");
    if ((kind === "local" && shapeFields.length !== 0)
        || (kind !== "local" && (shape === null || shape.length === 0))) {
      throw new FreshKicadParseError(`Schematic ${kind} label ${index + 1} has an unsupported electrical shape field.`);
    }
    return { name, at: position, kind, shape };
  });
  const junctions = children(root, "junction").map((entry, index) => {
    const position = point(entry, "at");
    if (position === null) throw new FreshKicadParseError(`Schematic junction ${index + 1} lacks an exact position.`);
    return position;
  });
  return Object.freeze({
    version, symbols: Object.freeze(symbols), noConnectCount: noConnects.length,
    noConnects: Object.freeze(noConnects), wires: Object.freeze(wires), labels: Object.freeze(labels), junctions: Object.freeze(junctions),
    childSheetCount: children(root, "sheet").length,
    classSources: Object.freeze({ netclassPropertyCount, unsupportedLabelPropertyCount, directiveLabelCount, ruleAreaCount: children(root, "rule_area").length }),
  });
}

function presentationChild(node: Node | null, name: string, context: string): Node | null {
  if (node === null) return null;
  const matches = children(node, name);
  if (matches.length > 1) throw new FreshKicadParseError(`${context} contains duplicate ${name} forms.`);
  return matches[0] ?? null;
}

function presentationFlag(
  name: "bold" | "italic" | "hide",
  locations: readonly { readonly node: Node | null; readonly bare: boolean }[],
  context: string,
): { readonly value: boolean; readonly origin: "explicit" | "omitted-default" } {
  const values: boolean[] = [];
  for (const location of locations) {
    if (location.node === null) continue;
    if (location.bare) for (const atom of location.node.values) {
      if (atom.value === name) {
        if (atom.quoted) throw new FreshKicadParseError(`${context} contains a quoted ${name} modifier.`);
        values.push(true);
      }
    }
    for (const field of children(location.node, name)) {
      if (field.children.length !== 0 || field.values.length > 1
          || field.values.some((atom) => atom.quoted || !["yes", "no"].includes(atom.value))) {
        throw new FreshKicadParseError(`${context} contains malformed ${name} metadata.`);
      }
      values.push(field.values[0]?.value !== "no");
    }
  }
  if (values.length > 1) throw new FreshKicadParseError(`${context} contains duplicate ${name} metadata.`);
  return { value: values[0] ?? false, origin: values.length === 0 ? "omitted-default" : "explicit" };
}

function schematicTextPresentation(node: Node | null, context: string): FreshSchematicTextPresentation {
  const atNode = presentationChild(node, "at", context);
  let at: FreshPoint | null = null;
  let rotationDeg: number | null = null;
  if (atNode !== null) {
    const values = atNode.values.map((atom) => atom.quoted ? null : number(atom.value));
    if (atNode.children.length !== 0 || ![2, 3].includes(values.length) || values.some((value) => value === null)) {
      throw new FreshKicadParseError(`${context} contains malformed position/rotation metadata.`);
    }
    at = Object.freeze({ x: values[0]!, y: values[1]! });
    rotationDeg = values[2] ?? null;
  }
  const effects = presentationChild(node, "effects", context);
  if (effects?.values.some((atom) => atom.quoted || atom.value !== "hide")) {
    throw new FreshKicadParseError(`${context} contains unsupported effects modifiers.`);
  }
  const font = presentationChild(effects, "font", context);
  if (font?.values.some((atom) => atom.quoted || !["bold", "italic"].includes(atom.value))) {
    throw new FreshKicadParseError(`${context} contains unsupported font modifiers.`);
  }
  const size = presentationChild(font, "size", context);
  let fontSizeMm: FreshPoint | null = null;
  if (size !== null) {
    const values = size.values.map((atom) => atom.quoted ? null : number(atom.value));
    if (size.children.length !== 0 || values.length !== 2 || values.some((value) => value === null || value <= 0)) {
      throw new FreshKicadParseError(`${context} contains malformed font-size metadata.`);
    }
    fontSizeMm = Object.freeze({ x: values[0]!, y: values[1]! });
  }
  const justifyNode = presentationChild(effects, "justify", context);
  let justify: readonly FreshSchematicJustification[] | null = null;
  if (justifyNode !== null) {
    const values = justifyNode.values.map((atom) => atom.value);
    const allowed = new Set<string>(["left", "right", "top", "bottom", "mirror"]);
    if (justifyNode.children.length !== 0 || justifyNode.values.some((atom) => atom.quoted || !allowed.has(atom.value))
        || new Set(values).size !== values.length
        || ["left", "right"].every((value) => values.includes(value))
        || ["top", "bottom"].every((value) => values.includes(value))) {
      throw new FreshKicadParseError(`${context} contains malformed or conflicting justification metadata.`);
    }
    justify = Object.freeze(values as FreshSchematicJustification[]);
  }
  const bold = presentationFlag("bold", [{ node: font, bare: true }], context);
  const italic = presentationFlag("italic", [{ node: font, bare: true }], context);
  const hidden = presentationFlag("hide", [{ node, bare: false }, { node: effects, bare: true }], context);
  return Object.freeze({ at, rotationDeg, justify, fontSizeMm, bold: bold.value, italic: italic.value, hidden: hidden.value,
    origins: Object.freeze({ at: atNode === null ? "omitted" : "explicit", rotationDeg: rotationDeg === null ? "omitted" : "explicit",
      justify: justifyNode === null ? "omitted" : "explicit", fontSizeMm: size === null ? "omitted" : "explicit",
      bold: bold.origin, italic: italic.origin, hidden: hidden.origin }) });
}

/**
 * Source-authored presentation facts, separate from the electrical projection.
 * It does not measure ink, estimate native glyph/body bounds, or substitute for
 * the electrical/class-source guards. Missing legacy fields are explicit nulls;
 * only omitted bold/italic/hide flags use their marked false defaults. Reference/Value
 * fields retain their stored page coordinates and angles without symbol transforms.
 */
export function parseFreshSchematicPresentationSource(source: string): FreshSchematicPresentationSource {
  const root = parseDocument(source, "kicad_sch");
  const versionNode = presentationChild(root, "version", "Schematic presentation");
  const version = versionNode === null ? null : versionNumber(scalar(root, "version"));
  if (versionNode !== null && (version === null || versionNode.values[0]?.quoted)) throw new FreshKicadParseError("Schematic presentation has a malformed version.");
  const labelKinds = { label: "local", global_label: "global", hierarchical_label: "hierarchical" } as const;
  const labels = root.children.filter((node) => Object.hasOwn(labelKinds, node.name)).map((node, index): FreshSchematicPresentationLabel => {
    const context = `Schematic presentation label ${index + 1}`;
    if (node.values.length !== 1 || node.values[0]!.value.length === 0
        || node.children.some((child) => child.start < node.values[0]!.end)) throw new FreshKicadParseError(`${context} lacks one exact name before its attributes.`);
    const text = schematicTextPresentation(node, context);
    if (text.at === null) throw new FreshKicadParseError(`${context} lacks an exact position.`);
    const kind = labelKinds[node.name as keyof typeof labelKinds];
    const shapeNode = presentationChild(node, "shape", context);
    const shape = shapeNode === null ? null : scalar(node, "shape");
    if ((kind === "local" && shapeNode !== null) || (kind !== "local" && (shape === null || shape.length === 0))) {
      throw new FreshKicadParseError(`${context} has an unsupported electrical shape field.`);
    }
    return Object.freeze({ name: node.values[0]!.value, kind, shape, ...text, at: text.at });
  });
  const symbolFields = children(root, "symbol").flatMap((symbol, symbolIndex): FreshSchematicPresentationField[] => {
    const context = `Schematic presentation symbol ${symbolIndex + 1}`;
    const fields = new Map<string, Node>();
    for (const field of children(symbol, "property")) {
      const offset = field.values[0]?.value === "private" && !field.values[0]!.quoted ? 1 : 0;
      if (field.values.length !== offset + 2 || field.values[offset]!.value.length === 0
          || field.children.some((child) => child.start < field.values.at(-1)!.end)) {
        throw new FreshKicadParseError(`${context} contains malformed property metadata.`);
      }
      const name = field.values[offset]!.value;
      if (fields.has(name)) throw new FreshKicadParseError(`${context} contains duplicate ${name} properties.`);
      fields.set(name, field);
    }
    const textOf = (field: Node | undefined): string | null => field === undefined ? null
      : field.values[field.values[0]?.value === "private" && !field.values[0]!.quoted ? 2 : 1]!.value;
    const reference = textOf(fields.get("Reference"));
    const symbolUuid = itemIdentity(symbol, context);
    return (["Reference", "Value"] as const).map((kind) => {
      const field = fields.get(kind);
      return Object.freeze({ kind, text: textOf(field), sourcePresent: field !== undefined, reference, symbolIndex, symbolUuid,
        ...schematicTextPresentation(field ?? null, `${context} ${kind} field`) });
    });
  });
  return Object.freeze({ version, labels: Object.freeze(labels), symbolFields: Object.freeze(symbolFields) });
}

const presentationTargetKey = (target: FreshSchematicPresentationFieldTarget): string => `${target.symbolIndex}:${target.kind}`;
const positionalJustifications = new Set<string>(["left", "right", "top", "bottom"]);

function fieldPresentationInvariant(
  source: string,
  targets: readonly FreshSchematicPresentationFieldTarget[],
): { readonly tokens: readonly string[]; readonly changes: ReadonlyMap<string, readonly unknown[]> } {
  if (typeof source !== "string" || !source.isWellFormed() || source.includes("\0")) {
    throw new FreshKicadParseError("Schematic presentation comparison requires scalar source text.");
  }
  if (source.length > MAX_SOURCE || Buffer.byteLength(source, "utf8") > MAX_SOURCE) {
    throw new FreshKicadParseError("Schematic presentation comparison source size is unsupported.");
  }
  const rawTokens: SourceSpan[] = [];
  const root = parseDocument(source, "kicad_sch", rawTokens);
  const presentation = parseFreshSchematicPresentationSource(source);
  const symbols = children(root, "symbol");
  const fields = new Map(presentation.symbolFields.map((field) => [presentationTargetKey(field), field]));
  const referenceCounts = new Map<string, number>();
  for (const field of presentation.symbolFields) if (field.kind === "Reference" && field.text !== null) {
    referenceCounts.set(field.text, (referenceCounts.get(field.text) ?? 0) + 1);
  }
  const masks = new Map<number, string>();
  const removedTokens = new Set<number>();
  const removedRanges: SourceSpan[] = [];
  const changes = new Map<string, readonly unknown[]>();
  for (const target of targets) {
    const key = presentationTargetKey(target);
    const field = fields.get(key);
    const symbol = symbols[target.symbolIndex];
    if (field === undefined || symbol === undefined || !field.sourcePresent || field.hidden
        || field.reference === null || field.reference.length === 0 || referenceCounts.get(field.reference) !== 1
        || field.at === null || field.rotationDeg === null) {
      throw new FreshKicadParseError(`Presentation target ${key} is missing, hidden, ambiguous, or lacks an explicit complete position.`);
    }
    const propertyNode = children(symbol, "property").find((propertyNode) => {
      const offset = propertyNode.values[0]?.value === "private" && !propertyNode.values[0]!.quoted ? 1 : 0;
      return propertyNode.values[offset]?.value === target.kind;
    })!;
    const atNode = presentationChild(propertyNode, "at", key)!;
    // The companion validated exactly three unquoted finite values for this
    // target. Keep the at operator and parentheses; mask only its three values.
    atNode.values.forEach((atom, index) => masks.set(atom.start, JSON.stringify(["field-at", key, index])));
    const effects = presentationChild(propertyNode, "effects", key);
    if (effects === null) throw new FreshKicadParseError(`Presentation target ${key} lacks an existing effects block.`);
    const justify = presentationChild(effects, "justify", key);
    if (justify !== null) {
      if (justify.values.some((atom) => atom.value === "mirror")) {
        // A mirror flag and its wrapper remain exact, even when positional
        // flags are inserted/removed around it.
        for (const atom of justify.values) if (positionalJustifications.has(atom.value)) removedTokens.add(atom.start);
      } else {
        // The validated node contains positional flags only (or is empty).
        // Omit its otherwise empty wrapper to support insertion/removal of
        // positional justification without masking any other effects content.
        removedRanges.push({ start: justify.start, end: justify.end });
      }
    }
    changes.set(key, [field.at.x, field.at.y, field.rotationDeg,
      [...(field.justify ?? [])].filter((value) => positionalJustifications.has(value)).sort()]);
  }
  removedRanges.sort((left, right) => left.start - right.start);
  const tokens: string[] = [];
  let previousEnd = 0;
  let previousValue = false;
  let rangeIndex = 0;
  for (const span of rawTokens) {
    const trivia = source.slice(previousEnd, span.start);
    if (!/^[ \t\r\n]*$/u.test(trivia) || /\r(?!\n)/u.test(trivia)) {
      throw new FreshKicadParseError("Schematic comparison contains unsupported non-ASCII or bare-CR layout whitespace.");
    }
    const raw = source.slice(span.start, span.end);
    const value = raw !== "(" && raw !== ")";
    if (previousValue && value && trivia.length === 0) throw new FreshKicadParseError("Schematic comparison contains adjacent value tokens without a delimiter.");
    if (value && !raw.startsWith('"') && (/[\u0000-\u001f\u007f";]/u.test(raw) || raw.startsWith("#") || raw.startsWith("//"))) {
      throw new FreshKicadParseError("Schematic comparison contains an unsupported atom or comment token.");
    }
    previousEnd = span.end;
    previousValue = value;
    while (rangeIndex < removedRanges.length && removedRanges[rangeIndex]!.end <= span.start) rangeIndex += 1;
    const range = removedRanges[rangeIndex];
    if (range !== undefined && range.start <= span.start && span.end <= range.end) continue;
    if (removedTokens.has(span.start)) continue;
    tokens.push(masks.get(span.start) ?? JSON.stringify(["raw", raw]));
  }
  const trailing = source.slice(previousEnd);
  if (!/^[ \t\r\n]*$/u.test(trailing) || /\r(?!\n)/u.test(trailing)) {
    throw new FreshKicadParseError("Schematic comparison contains unsupported trailing source text.");
  }
  return { tokens, changes };
}

/**
 * Source-bound permission check for an existing visible Reference/Value field
 * move. Apart from ASCII inter-token layout whitespace, every raw token stays
 * exact except selected at values and positional justify flags. Raw quoted
 * text/escapes, UUIDs, fonts, visibility, mirror, unknown fields, and all other
 * forms/order are retained. This does not prove readability or native parity;
 * callers retain raw source identities and verify the requested final values.
 */
export function compareFreshSchematicFieldPresentationSources(
  beforeSource: string,
  afterSource: string,
  expectedBeforeIdentity: ContentIdentity,
  targets: readonly FreshSchematicPresentationFieldTarget[],
): FreshSchematicFieldPresentationComparison {
  if (typeof beforeSource !== "string" || beforeSource.length === 0 || beforeSource.length > MAX_SOURCE
      || !beforeSource.isWellFormed() || beforeSource.includes("\0")) {
    throw new FreshKicadParseError("Schematic presentation comparison has unsupported before-source text.");
  }
  const size = Buffer.byteLength(beforeSource, "utf8");
  if (size > MAX_SOURCE || expectedBeforeIdentity?.algorithm !== "sha256"
      || expectedBeforeIdentity.size !== size
      || expectedBeforeIdentity.digest !== createHash("sha256").update(beforeSource, "utf8").digest("hex")) {
    throw new FreshKicadParseError("Schematic presentation comparison before-source identity does not match.");
  }
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_NODES
      || targets.some((target) => target === null || typeof target !== "object"
        || !Number.isSafeInteger(target.symbolIndex) || target.symbolIndex < 0
        || !["Reference", "Value"].includes(target.kind))) {
    throw new FreshKicadParseError("Schematic presentation targets must be a bounded nonempty list of exact field indices/kinds.");
  }
  if (new Set(targets.map(presentationTargetKey)).size !== targets.length) throw new FreshKicadParseError("Schematic presentation targets contain duplicate fields.");
  const before = fieldPresentationInvariant(beforeSource, targets);
  const after = fieldPresentationInvariant(afterSource, targets);
  const equal = before.tokens.length === after.tokens.length && before.tokens.every((token, index) => token === after.tokens[index]);
  const changedFieldCount = targets.filter((target) => {
    const key = presentationTargetKey(target);
    return JSON.stringify(before.changes.get(key)) !== JSON.stringify(after.changes.get(key));
  }).length;
  return Object.freeze({ equal, changedFieldCount });
}

/**
 * The generic authored-pattern model permits only intersheet-reference fields
 * on global labels. Arbitrary label metadata, directives and schematic rule
 * areas are unsupported model inputs; this is not a general KiCad validator.
 * Ordinary drawing forms, UUID/effects/autoplace metadata and legacy iref are
 * unaffected. Legacy workflows may inspect these facts without this guard.
 */
export function freshSchematicClassSourcesSupported(
  schematic: Pick<ReturnType<typeof parseFreshSchematicSource>, "classSources">,
): boolean {
  const sources = schematic.classSources;
  return sources.netclassPropertyCount === 0 && sources.unsupportedLabelPropertyCount === 0
    && sources.directiveLabelCount === 0 && sources.ruleAreaCount === 0;
}

/** Closed generic names require one passive global label per net, with no other labels. */
export function freshGlobalLabelInventoryMatches(
  schematic: Pick<ReturnType<typeof parseFreshSchematicSource>, "labels" | "classSources">,
  expectedNames: readonly string[],
): boolean {
  return freshSchematicClassSourcesSupported(schematic)
    && new Set(expectedNames).size === expectedNames.length
    && schematic.labels.length === expectedNames.length
    && expectedNames.every((name) => {
      const matches = schematic.labels.filter((label) => label.name === name);
      return matches.length === 1 && matches[0]!.kind === "global" && matches[0]!.shape === "passive";
    });
}

/** Exact host-planned tuples permit repeated names only at distinct anchors; legacy names-only checking remains separate. */
export function freshGlobalLabelTupleInventoryMatches(
  schematic: Pick<ReturnType<typeof parseFreshSchematicSource>, "labels" | "classSources">,
  expected: readonly Readonly<{ name: string; at: FreshPoint }>[],
): boolean {
  const tuple = (label: { name: string; at: FreshPoint }) => JSON.stringify([label.name, label.at.x, label.at.y]);
  const anchor = (label: { at: FreshPoint }) => JSON.stringify([label.at.x, label.at.y]);
  const keys = new Set(expected.map(tuple));
  return freshSchematicClassSourcesSupported(schematic) && expected.length > 0 && expected.length <= 8192
    && keys.size === expected.length && new Set(expected.map(anchor)).size === expected.length
    && schematic.labels.length === expected.length && new Set(schematic.labels.map(tuple)).size === expected.length
    && new Set(schematic.labels.map(anchor)).size === expected.length
    && schematic.labels.every(label => label.kind === "global" && label.shape === "passive" && keys.has(tuple(label)));
}

/** Repeated terminal labels use the stock stroke font only; unknown render metadata cannot hide behind parsed defaults. */
export function freshTerminalGlobalLabelPresentationSupported(source: string): boolean {
  const root = parseDocument(source, "kicad_sch");
  return children(root, "global_label").every(label => {
    if (label.children.some(child => !["shape", "at", "effects", "uuid", "fields_autoplaced", "property", "iref"].includes(child.name))) return false;
    const effects = one(label, "effects"), font = effects === null ? null : one(effects, "font");
    return effects !== null && effects.values.length === 0
      && effects.children.every(child => ["font", "justify", "hide"].includes(child.name)) && font !== null
      && font.values.every(value => !value.quoted && ["bold", "italic"].includes(value.value))
      && font.children.every(child => ["size", "bold", "italic"].includes(child.name));
  });
}

/** Bounded parser for the native `kicad-cli sch export netlist` parity gate. */
export function parseFreshNetlistSource(source: string): Readonly<{
  references: readonly string[];
  components: readonly FreshNetlistComponent[];
  nets: readonly FreshNetlistNet[];
}> {
  const root = parseDocument(source, "export");
  const componentsForm = one(root, "components");
  const netsForm = one(root, "nets");
  if (componentsForm === null || netsForm === null) {
    throw new FreshKicadParseError("KiCad netlist must contain exactly one components form and one nets form.");
  }
  const components = children(componentsForm, "comp").map((component, index): FreshNetlistComponent => {
    const reference = scalar(component, "ref");
    const value = scalar(component, "value");
    const footprintLibId = scalar(component, "footprint");
    const library = one(component, "libsource");
    const libraryName = library === null ? null : scalar(library, "lib");
    const part = library === null ? null : scalar(library, "part");
    if ([reference, value, footprintLibId, libraryName, part].some((entry) => entry === null || entry.length === 0)) {
      throw new FreshKicadParseError(`KiCad netlist component ${index + 1} lacks exact reference, value, footprint, or library identity.`);
    }
    return { reference: reference!, value: value!, footprintLibId: footprintLibId!, symbolLibId: `${libraryName!}:${part!}` };
  });
  const references = components.map((component) => component.reference);
  if (new Set(references).size !== references.length) throw new FreshKicadParseError("KiCad netlist contains duplicate component references.");
  const endpointKeys = new Set<string>();
  const nets = children(netsForm, "net").map((net, index): FreshNetlistNet => {
    const name = scalar(net, "name");
    if (name === null || name.length === 0) throw new FreshKicadParseError(`KiCad netlist net ${index + 1} lacks a name.`);
    const nodes = children(net, "node").map((node, nodeIndex): FreshNetlistNode => {
      const reference = scalar(node, "ref");
      const pin = scalar(node, "pin");
      const pinType = scalar(node, "pintype");
      if (reference === null || pin === null || pinType === null || reference.length === 0 || pin.length === 0 || pinType.length === 0) {
        throw new FreshKicadParseError(`KiCad netlist node ${index + 1}.${nodeIndex + 1} lacks an exact reference, pin, or pin type.`);
      }
      const key = `${reference}\u0000${pin}`;
      if (endpointKeys.has(key)) throw new FreshKicadParseError(`KiCad netlist assigns ${reference}.${pin} to multiple nets.`);
      endpointKeys.add(key);
      return { reference, pin, pinType };
    });
    return { name, nodes: Object.freeze(nodes) };
  });
  if (new Set(nets.map((net) => net.name)).size !== nets.length) throw new FreshKicadParseError("KiCad netlist contains duplicate net names.");
  return Object.freeze({ references: Object.freeze(references), components: Object.freeze(components), nets: Object.freeze(nets) });
}

function rotateTranslate(local: FreshPoint, at: FreshPoint, degrees: number): FreshPoint {
  const normalized = ((degrees % 360) + 360) % 360;
  // PCB coordinates use KiCad's RotatePoint convention: positive angles map
  // local +X toward board -Y. Stored flipped-footprint child coordinates are
  // already mirrored; do not mirror them again. This is not the schematic
  // symbol transform. Keep cardinal rotations free of trigonometric rounding.
  if (normalized === 0) return { x: at.x + local.x, y: at.y + local.y };
  if (normalized === 90) return { x: at.x + local.y, y: at.y - local.x };
  if (normalized === 180) return { x: at.x - local.x, y: at.y - local.y };
  if (normalized === 270) return { x: at.x - local.y, y: at.y + local.x };
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { x: at.x + local.x * cosine + local.y * sine, y: at.y - local.x * sine + local.y * cosine };
}

function bounds(points: readonly FreshPoint[]): FreshBounds | null {
  if (points.length === 0) return null;
  return {
    minX: Math.min(...points.map((entry) => entry.x)), minY: Math.min(...points.map((entry) => entry.y)),
    maxX: Math.max(...points.map((entry) => entry.x)), maxY: Math.max(...points.map((entry) => entry.y)),
  };
}

function graphicPoints(node: Node): readonly FreshPoint[] {
  if (node.name === "fp_line" || node.name === "gr_line" || node.name === "fp_rect" || node.name === "gr_rect") {
    const start = point(node, "start");
    const end = point(node, "end");
    if (start === null || end === null) return [];
    return node.name.endsWith("rect")
      ? [start, { x: start.x, y: end.y }, end, { x: end.x, y: start.y }]
      : [start, end];
  }
  return [];
}

function footprintBounds(node: Node, footprintAt: FreshPoint, rotation: number, wantedLayer: string): FreshBounds | null {
  const points = node.children.flatMap((graphic) => {
    const layer = scalar(graphic, "layer");
    return layer === wantedLayer ? graphicPoints(graphic).map((entry) => rotateTranslate(entry, footprintAt, rotation)) : [];
  });
  return bounds(points);
}

/** Exact top-level board-text spans for narrow presentation-only preservation checks. */
export function parseFreshPcbTextItems(source: string) {
  const root = parseDocument(source, "kicad_pcb");
  return Object.freeze(root.children.filter(node => node.name === "gr_text").map(node => {
    if (!node.values[0]?.quoted) throw new FreshKicadParseError("Unsupported board text value.");
    const effects = one(node, "effects"), font = effects === null ? null : one(effects, "font");
    const lineSpacing = font === null ? [] : children(font, "line_spacing");
    // Pinned DOC3 creates single-line BoardText with scalar line_spacing 0.
    // Admit only that captured spelling; no multiline or other font relaxation.
    const capturedLineSpacing = lineSpacing.length === 0 || (lineSpacing.length === 1
      && lineSpacing[0]!.children.length === 0 && lineSpacing[0]!.values.length === 1
      && !lineSpacing[0]!.values[0]!.quoted && lineSpacing[0]!.values[0]!.value === "0");
    const supported = node.values.length === 1
      && !/[\r\n]/u.test(node.values[0]!.value) && capturedLineSpacing
      && node.children.every(child => ["at", "layer", "uuid", "effects"].includes(child.name))
      && new Set(node.children.map(child => child.name)).size === node.children.length
      && effects !== null && effects.children.every(child => ["font", "justify"].includes(child.name))
      && font !== null && font.children.every(child => ["size", "thickness", "bold", "italic", "line_spacing"].includes(child.name));
    return Object.freeze({ start: node.start, end: node.end, id: itemIdentity(node, "Board text"),
      text: node.values[0]!.value, layer: scalar(node, "layer"), supported,
      presentation: schematicTextPresentation(node, "Board text") });
  }));
}

/** Shared exact legacy-ID / current name-bound resolver; never guesses a net. */
function freshPcbNetResolver(root: Node): (net: Node | null) => string | null {
  const numericNets = new Map<string, string>();
  const netOrdinalsByName = new Map<string, string>();
  for (const net of children(root, "net")) {
    const ordinal = net.values[0]?.value;
    const name = net.values[1]?.value;
    if (net.values.length !== 2 || ordinal === undefined || name === undefined || !/^\d+$/u.test(ordinal) || numericNets.has(ordinal) || netOrdinalsByName.has(name)) {
      throw new FreshKicadParseError("PCB net table is malformed or has duplicate/conflicting IDs or names.");
    }
    if ((ordinal === "0") !== (name === "")) throw new FreshKicadParseError("PCB net 0 must be the empty no-net entry, and named nets must use nonzero IDs.");
    numericNets.set(ordinal, name);
    netOrdinalsByName.set(name, ordinal);
  }
  return (net: Node | null): string | null => {
    if (net === null) return null;
    if (net.children.length !== 0 || net.values.length < 1 || net.values.length > 2) throw new FreshKicadParseError("PCB item net reference is malformed.");
    const ordinal = net.values[0]!.value;
    if (net.values[0]!.quoted) {
      if (net.values.length !== 1) throw new FreshKicadParseError("A quoted PCB net name must be the only value in its net reference.");
      if (ordinal.length === 0) return null;
      const declaredOrdinal = netOrdinalsByName.get(ordinal);
      // KiCad 10 writes name-bound item nets without a root numeric table. If
      // a legacy table is present, it remains authoritative and must agree.
      if (numericNets.size > 0 && (declaredOrdinal === undefined || declaredOrdinal === "0")) throw new FreshKicadParseError(`PCB item references undeclared net name ${ordinal}.`);
      return ordinal;
    }
    if (net.values.length === 2) {
      const name = net.values[1]!.value;
      if (!/^\d+$/u.test(ordinal)) throw new FreshKicadParseError("PCB item net ID is not a nonnegative integer.");
      if (ordinal === "0") {
        if (name !== "") throw new FreshKicadParseError("PCB item net 0 cannot carry a named net.");
        return null;
      }
      if (numericNets.get(ordinal) !== name || netOrdinalsByName.get(name) !== ordinal) throw new FreshKicadParseError(`PCB item net ${ordinal}/${name} disagrees with the board net table.`);
      return name;
    }
    if (/^\d+$/u.test(ordinal)) {
      if (ordinal === "0") return null;
      const resolved = numericNets.get(ordinal);
      if (resolved === undefined || resolved === "") throw new FreshKicadParseError(`PCB item references undeclared net ID ${ordinal}.`);
      return resolved;
    }
    throw new FreshKicadParseError("PCB item net reference is neither a declared ID nor name.");
  };
}

export function parseFreshPcbSource(source: string): FreshParsedPcb {
  const root = parseDocument(source, "kicad_pcb");
  const allItemIdentities: string[] = [];
  const collectItemIdentities = (node: Node): void => {
    if ((node.name === "uuid" || node.name === "tstamp")) {
      if (node.children.length !== 0 || node.values.length !== 1 || node.values[0]!.value.length === 0) {
        throw new FreshKicadParseError("PCB contains a malformed uuid/tstamp identity field.");
      }
      allItemIdentities.push(node.values[0]!.value);
    }
    node.children.forEach(collectItemIdentities);
  };
  collectItemIdentities(root);
  if (new Set(allItemIdentities).size !== allItemIdentities.length) {
    throw new FreshKicadParseError("PCB contains duplicate object uuid/tstamp identities across route or non-route items.");
  }
  if (children(root, "arc").length > 0) {
    throw new FreshKicadParseError("Routed PCB arcs are outside the current mitered straight-segment contract.");
  }
  const version = versionNumber(scalar(root, "version"));
  const netName = freshPcbNetResolver(root);
  const footprints = children(root, "footprint").map((footprint, index): FreshPcbFootprint => {
    const libraryId = footprint.values.length === 1 ? footprint.values[0]!.value : null;
    const reference = property(footprint, "Reference");
    const value = property(footprint, "Value") ?? "";
    const layer = scalar(footprint, "layer");
    const atNode = one(footprint, "at");
    const x = number(atNode?.values[0]?.value);
    const y = number(atNode?.values[1]?.value);
    const rotationDeg = number(atNode?.values[2]?.value) ?? 0;
    if (libraryId === null || reference === null || layer === null || atNode === null || x === null || y === null) {
      throw new FreshKicadParseError(`PCB footprint ${index + 1} lacks exact identity or placement.`);
    }
    const at = { x, y };
    const pads = children(footprint, "pad").map((pad, padIndex): FreshPcbPad => {
      const padAt = one(pad, "at");
      const padX = number(padAt?.values[0]?.value);
      const padY = number(padAt?.values[1]?.value);
      const layerField = one(pad, "layers");
      const layers = layerField?.values.map((entry) => entry.value) ?? [];
      if (pad.values.length < 1 || padX === null || padY === null || layerField === null
          || layerField.children.length !== 0 || layers.length === 0
          || new Set(layers).size !== layers.length) {
        throw new FreshKicadParseError(`PCB footprint ${reference} pad ${padIndex + 1} is malformed.`);
      }
      const sizeNode = one(pad, "size");
      const sizeX = number(sizeNode?.values[0]?.value), sizeY = number(sizeNode?.values[1]?.value);
      const drillNode = one(pad, "drill");
      let drill: FreshPcbPad["physical"]["drill"] = null;
      if (drillNode !== null) {
        const oval = drillNode.values[0]?.value === "oval" && !drillNode.values[0]!.quoted;
        const values = drillNode.values.slice(oval ? 1 : 0);
        const dx = number(values[0]?.value), dy = oval ? number(values[1]?.value) : dx;
        const offset = one(drillNode, "offset");
        const ox = number(offset?.values[0]?.value), oy = number(offset?.values[1]?.value);
        if (dx === null || dy === null || dx <= 0 || dy <= 0 || values.length !== (oval ? 2 : 1)
            || drillNode.children.some((child) => child.name !== "offset") || children(drillNode, "offset").length > 1
            || offset !== null && (ox === null || oy === null || offset.values.length !== 2 || offset.children.length !== 0)) {
          throw new FreshKicadParseError(`PCB footprint ${reference} pad ${padIndex + 1} has malformed drill geometry.`);
        }
        drill = Object.freeze({ shape: oval ? "oval" : "circle", sizeMm: Object.freeze({ x: dx, y: dy }),
          offsetMm: offset === null ? null : Object.freeze({ x: ox!, y: oy! }) });
      }
      const padRotation = number(padAt?.values[2]?.value) ?? 0;
      return {
        number: pad.values[0]!.value,
        // The electrical anchor uses footprint-relative `at` coordinates.
        // The stored pad angle is already its absolute board orientation, not
        // an angle to add to the footprint's rotation. It and copper `offset`
        // affect shape geometry, not the connection anchor extracted here.
        at: rotateTranslate({ x: padX, y: padY }, at, rotationDeg),
        netName: netName(one(pad, "net")),
        layers: Object.freeze(layers),
        physical: Object.freeze({ id: itemIdentity(pad, `PCB footprint ${reference} pad ${padIndex + 1}`),
          padType: pad.values[1]?.value ?? null, shape: pad.values[2]?.value ?? null,
          relativeAt: Object.freeze({ x: padX, y: padY }), rotationDeg: padRotation,
          sizeMm: sizeNode === null || sizeX === null || sizeY === null ? null : Object.freeze({ x: sizeX, y: sizeY }),
          roundrectRatio: number(scalar(pad,"roundrect_rratio")??undefined),
          drill, source: source.slice(pad.start, pad.end), definitionKey: physicalPadDefinitionKey(pad) }),
      };
    });
    return {
      id: itemIdentity(footprint, `PCB footprint ${reference}`), reference, libraryId, value, layer, at, rotationDeg,
      courtyardBounds: footprintBounds(footprint, at, rotationDeg, "F.CrtYd"),
      bodyBounds: footprintBounds(footprint, at, rotationDeg, "F.Fab"),
      pads,
    };
  });
  const segments = children(root, "segment").map((segment, index): FreshPcbSegment => {
    const start = point(segment, "start");
    const end = point(segment, "end");
    const widthMm = number(scalar(segment, "width") ?? undefined);
    const layer = scalar(segment, "layer");
    if (start === null || end === null || widthMm === null || layer === null) throw new FreshKicadParseError(`PCB segment ${index + 1} is malformed.`);
    const id = itemIdentity(segment, `PCB segment ${index + 1}`);
    return { id, start, end, widthMm, layer, netName: netName(one(segment, "net")) };
  });
  const vias = children(root, "via").map((via, index): FreshPcbVia => {
    const at = point(via, "at");
    const diameterMm = number(scalar(via, "size") ?? undefined);
    const drillMm = number(scalar(via, "drill") ?? undefined);
    const layerField = one(via, "layers");
    const layers = layerField?.values.map((entry) => entry.value) ?? [];
    const id = itemIdentity(via, `PCB via ${index + 1}`);
    const typeFields = children(via, "type");
    const viaType = scalar(via, "type");
    if (at === null || diameterMm === null || drillMm === null || layerField === null
        || layerField.children.length !== 0 || layers.length < 2
        || new Set(layers).size !== layers.length
        || (typeFields.length > 0 && viaType !== "through")) {
      throw new FreshKicadParseError(`PCB via ${index + 1} is malformed.`);
    }
    return { id, at, diameterMm, drillMm, layers: Object.freeze(layers), netName: netName(one(via, "net")) };
  });
  const outlineGraphics = root.children.filter((entry) => scalar(entry, "layer") === "Edge.Cuts");
  const outlineSupported = outlineGraphics.length > 0 && outlineGraphics.every((entry) => entry.name === "gr_line" || entry.name === "gr_rect");
  const outlineBounds = outlineSupported ? bounds(outlineGraphics.flatMap(graphicPoints)) : null;
  const zoneNetNames = children(root, "zone").map((zone) => netName(one(zone, "net")) ?? scalar(zone, "net_name")).filter((name): name is string => name !== null);
  return Object.freeze({
    version, footprints: Object.freeze(footprints), segments: Object.freeze(segments), vias: Object.freeze(vias),
    viaCount: vias.length, zoneNetNames: Object.freeze(zoneNetNames), outlineBounds, outlineSupported,
  });
}

/* Append to fresh-kicad-parser.ts; intentionally uses its existing private bounded reader. */

export interface FreshSchematicTerminalPinGeometry {
  readonly number: string;
  readonly name: string;
  readonly electricalType: string;
  readonly graphicalShape: string;
  readonly at: Readonly<{ xMm: number; yMm: number }>;
  readonly angleDeg: 0 | 90 | 180 | 270;
  readonly lengthMm: number;
  readonly hidden: boolean;
  readonly unit: number;
  readonly bodyStyle: number;
}

export interface FreshSymbolTerminalGeometry {
  readonly libraryId: string;
  readonly sourceIdentity: ContentIdentity;
  readonly definitionIdentity: ContentIdentity;
  readonly rootGraphics: readonly FreshSchematicBodyGraphic[];
  readonly representations: readonly Readonly<{
    unit: number; bodyStyle: number; pins: readonly FreshSchematicTerminalPinGeometry[]; graphics: readonly FreshSchematicBodyGraphic[];
  }>[];
}

export interface FreshPlacedSchematicTerminalGeometry {
  readonly reference: string;
  readonly symbolLibId: string;
  readonly symbolUuid: string | null;
  readonly unit: number;
  readonly bodyStyle: 1 | 2;
  readonly bodyStyleOrigin: "explicit" | "omitted-default";
  readonly sourceIdentity: ContentIdentity;
  readonly embeddedDefinitionIdentity: ContentIdentity;
  /** Complete embedded unit/body inventory, so a single-unit consumer cannot overlook added units. */
  readonly embeddedGeometry: FreshSymbolTerminalGeometry;
  readonly placement: Readonly<{ at: Readonly<{ xMm: number; yMm: number }>; rotationDeg: 0 | 90 | 180 | 270 }>;
  readonly pins: readonly FreshSchematicTerminalPinGeometry[];
}

function terminalIdentity(source: string, expected?: ContentIdentity): ContentIdentity {
  if (!source.isWellFormed() || source.includes("\u0000") || Buffer.byteLength(source, "utf8") > 24 * 1024 * 1024) {
    throw new FreshKicadParseError("Terminal geometry source is unsupported UTF-8 text or exceeds its byte bound.");
  }
  const actual = Object.freeze({ algorithm: "sha256" as const, digest: createHash("sha256").update(source, "utf8").digest("hex"), size: Buffer.byteLength(source, "utf8") });
  if (expected !== undefined && (expected.algorithm !== "sha256" || expected.digest !== actual.digest || expected.size !== actual.size)) {
    throw new FreshKicadParseError("Terminal geometry source identity does not match the exact supplied source.");
  }
  return actual;
}

function terminalField(node: Node, name: string, context: string, optional = false): Node | null {
  const fields = children(node, name);
  if (fields.length > 1 || (!optional && fields.length !== 1)) throw new FreshKicadParseError(`${context}: missing or duplicate ${name}.`);
  return fields[0] ?? null;
}

function terminalScalar(node: Node, name: string, context: string): string {
  const field = terminalField(node, name, context)!;
  if (field.values.length !== 1 || field.children.length !== 0) throw new FreshKicadParseError(`${context}: malformed ${name}.`);
  return field.values[0]!.value;
}

function terminalProperties(node: Node, context: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const field of children(node, "property")) {
    const offset = field.values[0]?.value === "private" && !field.values[0].quoted ? 1 : 0;
    if (field.values.length !== offset + 2 || field.values[offset]!.value.length === 0
        || field.children.some((child) => child.start < field.values.at(-1)!.end)) throw new FreshKicadParseError(`${context}: malformed property.`);
    const name = field.values[offset]!.value;
    if (result.has(name)) throw new FreshKicadParseError(`${context}: duplicate ${name} property.`);
    result.set(name, field.values[offset + 1]!.value);
  }
  return result;
}

function terminalAt(node: Node, context: string): Readonly<{ at: Readonly<{ xMm: number; yMm: number }>; angleDeg: 0 | 90 | 180 | 270 }> {
  const at = terminalField(node, "at", context)!;
  const values = at.values.map((atom) => atom.quoted ? null : number(atom.value));
  if (at.children.length !== 0 || values.length !== 3 || values.some((value) => value === null)
      || Math.abs(values[0]!) > 2000 || Math.abs(values[1]!) > 2000 || ![0, 90, 180, 270].includes(values[2]!)) {
    throw new FreshKicadParseError(`${context}: unsupported position or non-cardinal angle.`);
  }
  return Object.freeze({ at: Object.freeze({ xMm: values[0]! === 0 ? 0 : values[0]!, yMm: values[1]! === 0 ? 0 : values[1]! }), angleDeg: values[2]! as 0 | 90 | 180 | 270 });
}

function terminalPositiveSelector(node: Node, name: string, context: string, defaultValue?: number): number {
  const field = terminalField(node, name, context, defaultValue !== undefined);
  if (field === null) return defaultValue!;
  const value = field.values[0];
  if (field.children.length !== 0 || field.values.length !== 1 || value!.quoted || !/^[1-9][0-9]*$/u.test(value!.value)
      || Number(value!.value) > 128) throw new FreshKicadParseError(`${context}: unsupported ${name} selector.`);
  return Number(value!.value);
}

function terminalDefinitionGeometry(source: string, sourceIdentity: ContentIdentity, definition: Node, libraryId: string, embedded: boolean): FreshSymbolTerminalGeometry {
  const item = libraryId.slice(libraryId.indexOf(":") + 1);
  const context = `Terminal symbol ${libraryId}`;
  if (definition.values.length !== 1 || !definition.values[0]!.quoted || definition.values[0]!.value !== (embedded ? libraryId : item)
      || definition.children.some((child) => child.start < definition.values[0]!.end)) {
    throw new FreshKicadParseError(`${context}: malformed definition name.`);
  }
  if (descendants(definition, "extends").length > 0 || descendants(definition, "alias").length > 0) {
    throw new FreshKicadParseError(`${context}: inherited/alias geometry is unsupported, not partially projected.`);
  }
  terminalProperties(definition, context);
  if (children(definition, "pin").length !== 0) throw new FreshKicadParseError(`${context}: unscoped root pins are unsupported.`);
  const representations = children(definition, "symbol");
  if (representations.length === 0 || representations.length > 512) throw new FreshKicadParseError(`${context}: unsupported representation inventory.`);
  const selectors = new Set<string>();
  let parsedPinCount = 0;
  const parsed = representations.map((representation) => {
    const name = representation.values[0]?.value;
    const suffix = name?.startsWith(`${item}_`) ? name.slice(item.length + 1) : "";
    const match = /^(0|[1-9][0-9]*)_(0|1|2)$/u.exec(suffix);
    if (representation.values.length !== 1 || !representation.values[0]!.quoted || match === null
        || Number(match[1]) > 128 || children(representation, "symbol").length !== 0
        || representation.children.some((child) => child.start < representation.values[0]!.end)) {
      throw new FreshKicadParseError(`${context}: unsupported nested unit/body representation.`);
    }
    const unit = Number(match[1]);
    const bodyStyle = Number(match[2]);
    const selector = `${unit}:${bodyStyle}`;
    if (selectors.has(selector)) throw new FreshKicadParseError(`${context}: duplicate unit/body representation.`);
    selectors.add(selector);
    const numbers = new Set<string>();
    const pins = children(representation, "pin").map((pin): FreshSchematicTerminalPinGeometry => {
      parsedPinCount += 1;
      if (parsedPinCount > 16384 || pin.values.length !== 2 || pin.values.some((atom) => atom.quoted || atom.value.length === 0)
          || pin.children.some((child) => child.start < pin.values.at(-1)!.end)) {
        throw new FreshKicadParseError(`${context}: malformed pin type/shape or pin inventory exceeds its bound.`);
      }
      const pinNumber = terminalField(pin, "number", context)!;
      const pinName = terminalField(pin, "name", context)!;
      if (pinNumber.values.length !== 1 || pinName.values.length !== 1
          || !/^[A-Za-z0-9][A-Za-z0-9.+/_-]{0,31}$/u.test(pinNumber.values[0]!.value)
          || pinName.values[0]!.value.length > 16384
          || [pinNumber, pinName].some((field) => field.children.length > 1 || field.children.some((child) => child.name !== "effects" || child.start < field.values[0]!.end))) {
        throw new FreshKicadParseError(`${context}: malformed pin number/name.`);
      }
      const numberValue = pinNumber.values[0]!.value;
      if (numbers.has(numberValue)) throw new FreshKicadParseError(`${context}: duplicate pin ${numberValue} in a representation.`);
      numbers.add(numberValue);
      const at = terminalAt(pin, `${context} pin ${numberValue}`);
      const length = terminalField(pin, "length", context)!;
      const lengthMm = length.values[0]?.quoted ? null : number(length.values[0]?.value);
      if (length.values.length !== 1 || length.children.length !== 0 || lengthMm === null || lengthMm < 0 || lengthMm > 2000) throw new FreshKicadParseError(`${context}: malformed pin length.`);
      const hide = terminalField(pin, "hide", context, true);
      if (hide !== null && (hide.children.length !== 0 || hide.values.length !== 1 || hide.values[0]!.quoted || !["yes", "no"].includes(hide.values[0]!.value))) {
        throw new FreshKicadParseError(`${context}: unsupported pin visibility encoding.`);
      }
      return Object.freeze({ number: numberValue, name: pinName.values[0]!.value, electricalType: pin.values[0]!.value, graphicalShape: pin.values[1]!.value,
        ...at, lengthMm, hidden: hide?.values[0]?.value === "yes", unit, bodyStyle });
    });
    if (pins.length > 128) throw new FreshKicadParseError(`${context}: too many pins in one representation.`);
    const graphics = representation.children.filter((child) => child.name !== "pin" && child.name !== "unit_name")
      .map((child) => terminalBodyGraphic(source, child));
    return Object.freeze({ unit, bodyStyle, pins: Object.freeze(pins), graphics: Object.freeze(graphics) });
  });
  if (parsedPinCount !== descendants(definition, "pin").length) throw new FreshKicadParseError(`${context}: unprojected nested pins are unsupported.`);
  const rootMetadata = new Set(["symbol", "property", "pin_names", "pin_numbers", "exclude_from_sim", "in_bom", "on_board", "in_pos_files",
    "duplicate_pin_numbers_are_jumpers", "power", "body_styles", "embedded_fonts", "embedded_files"]);
  const rootGraphics = definition.children.filter((child) => !rootMetadata.has(child.name)).map((child) => terminalBodyGraphic(source, child));
  return Object.freeze({ libraryId, sourceIdentity, definitionIdentity: terminalIdentity(source.slice(definition.start, definition.end)),
    rootGraphics: Object.freeze(rootGraphics), representations: Object.freeze(parsed) });
}

/** Raw-source extraction only: approval must come from the host's allowlisted resolver. */
export function parseFreshSymbolLibraryTerminalGeometrySource(source: string, expectedIdentity: ContentIdentity, libraryId: string): FreshSymbolTerminalGeometry {
  if (!/^[^\s:]+:[^\s:]+$/u.test(libraryId) || libraryId.includes("{slash}")) throw new FreshKicadParseError("Terminal library ID is unsupported.");
  const identity = terminalIdentity(source, expectedIdentity);
  const root = parseDocument(source, "kicad_symbol_lib");
  const item = libraryId.slice(libraryId.indexOf(":") + 1);
  const definitions = children(root, "symbol").filter((entry) => entry.values[0]?.value === item);
  if (definitions.length !== 1) throw new FreshKicadParseError(`Expected exactly one stock ${libraryId} definition.`);
  return terminalDefinitionGeometry(source, identity, definitions[0]!, libraryId, false);
}

/** Select common unit/body representations and the exact placed selectors; never deduplicate pins. */
export function selectFreshSymbolTerminalGeometryPins(geometry: FreshSymbolTerminalGeometry, unit: number, bodyStyle: 1 | 2): readonly FreshSchematicTerminalPinGeometry[] {
  if (!Number.isSafeInteger(unit) || unit < 1 || unit > 128 || ![1, 2].includes(bodyStyle)
      || (!geometry.representations.some((entry) => entry.unit === unit)
        && !(unit === 1 && geometry.representations.every((entry) => entry.unit === 0)))
      || (bodyStyle === 2 && !geometry.representations.some((entry) => entry.bodyStyle === 2))) {
    throw new FreshKicadParseError(`Terminal symbol ${geometry.libraryId}: selected unit/body does not exist.`);
  }
  const pins = geometry.representations.filter((entry) => (entry.unit === 0 || entry.unit === unit) && (entry.bodyStyle === 0 || entry.bodyStyle === bodyStyle)).flatMap((entry) => entry.pins);
  const numbers = pins.map((pin) => pin.number);
  if (pins.length === 0 || pins.length > 128 || new Set(numbers).size !== pins.length) {
    throw new FreshKicadParseError(`Terminal symbol ${geometry.libraryId}: empty, excessive, or ambiguous selected pin inventory.`);
  }
  return Object.freeze(pins);
}

/** Complete root-instance terminal geometry, bound to the exact current schematic source. */
export function parseFreshSchematicTerminalGeometrySource(source: string, expectedIdentity: ContentIdentity, auxiliaryReferences: readonly string[] = []): readonly FreshPlacedSchematicTerminalGeometry[] {
  if (auxiliaryReferences.length > 16 || new Set(auxiliaryReferences).size !== auxiliaryReferences.length || auxiliaryReferences.some(reference => !/^#FLG[0-9]{3}$/u.test(reference))) throw new FreshKicadParseError("Invalid host auxiliary reference inventory.");
  const identity = terminalIdentity(source, expectedIdentity);
  const root = parseDocument(source, "kicad_sch");
  if (children(root, "sheet").length !== 0) throw new FreshKicadParseError("Terminal extraction does not support child-sheet instances.");
  const library = terminalField(root, "lib_symbols", "Terminal schematic")!;
  if (library.values.length !== 0) throw new FreshKicadParseError("Terminal schematic has malformed lib_symbols metadata.");
  const definitions = new Map<string, Node>();
  for (const definition of children(library, "symbol")) {
    const id = definition.values[0]?.value;
    if (definition.values.length !== 1 || id === undefined || definitions.has(id)) throw new FreshKicadParseError("Terminal schematic contains malformed or duplicate embedded definitions.");
    definitions.set(id, definition);
  }
  const symbols = children(root, "symbol");
  if (symbols.length === 0 || symbols.length > 64 + auxiliaryReferences.length) throw new FreshKicadParseError("Terminal schematic component inventory is outside its supported bound.");
  const references = new Set<string>();
  return Object.freeze(symbols.map((symbol): FreshPlacedSchematicTerminalGeometry => {
    const context = "Terminal placed symbol";
    if (symbol.values.length !== 0 || children(symbol, "mirror").length !== 0 || children(symbol, "lib_name").length !== 0) {
      throw new FreshKicadParseError(`${context}: mirrored, alternate library-name, or malformed instances are unsupported.`);
    }
    const reference = terminalProperties(symbol, context).get("Reference");
    if (reference === undefined || (!/^[A-Z][A-Z0-9_-]{0,31}$/u.test(reference) && !auxiliaryReferences.includes(reference)) || references.has(reference)) {
      throw new FreshKicadParseError(`${context}: missing/duplicate reference or repeated multi-unit instance is unsupported.`);
    }
    references.add(reference);
    const symbolLibId = terminalScalar(symbol, "lib_id", context);
    if (!/^[^\s:]+:[^\s:]+$/u.test(symbolLibId) || symbolLibId.includes("{slash}")) throw new FreshKicadParseError(`${context}: malformed or legacy-escaped library ID.`);
    const unit = terminalPositiveSelector(symbol, "unit", context);
    // KiCad 10 uses body_style; convert is its legacy alias, never a second independent selector.
    const selectors = symbol.children.filter((child) => child.name === "convert" || child.name === "body_style");
    if (selectors.length > 1) throw new FreshKicadParseError(`${context}: duplicate body-style selectors.`);
    const convert = selectors[0] ?? null;
    const bodyStyle = terminalPositiveSelector(symbol, convert?.name ?? "body_style", context, 1);
    if (bodyStyle !== 1 && bodyStyle !== 2) throw new FreshKicadParseError(`${context}: unsupported body style.`);
    const at = terminalAt(symbol, context);
    const definition = definitions.get(symbolLibId);
    if (definition === undefined) throw new FreshKicadParseError(`${context}: missing embedded definition.`);
    const geometry = terminalDefinitionGeometry(source, identity, definition, symbolLibId, true);
    const pins = selectFreshSymbolTerminalGeometryPins(geometry, unit, bodyStyle);
    const instancePins = children(symbol, "pin");
    if (instancePins.length !== 0) {
      for (const pin of instancePins) {
        if (pin.children.some((child) => child.name !== "uuid")) throw new FreshKicadParseError(`${context}: alternate or unsupported instance pin metadata.`);
        itemIdentity(pin, `${context} pin`);
      }
      const numbers = instancePins.map((pin) => pin.values.length === 1 ? pin.values[0]!.value : "");
      if (numbers.length !== pins.length || new Set(numbers).size !== numbers.length || numbers.some((value) => !pins.some((pin) => pin.number === value))) {
        throw new FreshKicadParseError(`${context}: instance pin inventory differs from complete selected embedded pins.`);
      }
    }
    return Object.freeze({ reference, symbolLibId, symbolUuid: itemIdentity(symbol, context), unit, bodyStyle,
      bodyStyleOrigin: convert === null ? "omitted-default" : "explicit", sourceIdentity: identity, embeddedDefinitionIdentity: geometry.definitionIdentity, embeddedGeometry: geometry,
      placement: Object.freeze({ at: at.at, rotationDeg: at.angleDeg }), pins });
  }));
}

/** Complete power definition token identity; only the qualified root name is normalized. */
export function freshPowerFlagDefinitionSemanticIdentity(source: string, expectedIdentity: ContentIdentity, embedded: boolean): ContentIdentity {
  terminalIdentity(source, expectedIdentity);
  const root = parseDocument(source, embedded ? "kicad_sch" : "kicad_symbol_lib");
  const parent = embedded ? terminalField(root, "lib_symbols", "External power definition")! : root;
  const name = embedded ? "power:PWR_FLAG" : "PWR_FLAG";
  const definitions = children(parent, "symbol").filter(node => node.values[0]?.value === name);
  if (definitions.length !== 1) throw new FreshKicadParseError("External power flag requires one exact embedded or stock definition.");
  const definition = definitions[0]!;
  const project = (node: Node): unknown => ({ name: node.name, values: node.values.map((atom, index) => ({ quoted: atom.quoted, value: node === definition && index === 0 ? "PWR_FLAG" : atom.value })), children: node.children.map(project) });
  return terminalIdentity(JSON.stringify(project(definition)));
}

/** Retain every parsed token except the explicitly named added flag instances/definition. */
export function freshExternalPowerRetainedSourceIdentity(source: string, references: readonly string[]): ContentIdentity {
  const root = parseDocument(source, "kicad_sch");
  const project = (node: Node): unknown => ({ name: node.name, values: node.values.map(atom => ({ quoted: atom.quoted, value: atom.value })),
    children: node.children.filter(child => !(node === root && child.name === "symbol" && references.includes(terminalProperties(child, "External power retained source").get("Reference") ?? ""))
      && !(node.name === "lib_symbols" && child.name === "symbol" && child.values[0]?.value === "power:PWR_FLAG")).map(project) });
  return terminalIdentity(JSON.stringify(project(root)));
}

/** Strict auxiliary metadata omitted by the ordinary physical component projection. */
export function parseFreshSchematicPowerFlagInstances(source: string, expectedIdentity: ContentIdentity, references: readonly string[]) {
  const placed = parseFreshSchematicTerminalGeometrySource(source, expectedIdentity, references);
  const root = parseDocument(source, "kicad_sch");
  const rootUuid = terminalScalar(root, "uuid", "External power schematic");
  const allUuids = descendants(root, "uuid").map(node => node.values.length === 1 ? node.values[0]!.value : "");
  const auxiliary = placed.filter(component => references.includes(component.reference));
  const metadata = auxiliary.map(component => {
    const matches = children(root, "symbol").filter(node => terminalProperties(node, "External power instance").get("Reference") === component.reference);
    if (matches.length !== 1) throw new FreshKicadParseError("External power instance inventory is ambiguous.");
    const symbol = matches[0]!, context = `External power ${component.reference}`;
    const allowed = new Set(["lib_id", "at", "unit", "body_style", "convert", "in_bom", "on_board", "dnp", "uuid", "property", "pin", "instances", "fields_autoplaced", "exclude_from_sim"]);
    if (symbol.children.some(node => !allowed.has(node.name))) throw new FreshKicadParseError(`${context}: unsupported instance metadata.`);
    for (const name of allowed) if (name !== "property" && children(symbol, name).length > 1) throw new FreshKicadParseError(`${context}: duplicate instance metadata.`);
    for (const name of ["in_bom", "on_board", "dnp", "exclude_from_sim"]) if (children(symbol, name).some(node => node.values.some(atom => atom.quoted))) throw new FreshKicadParseError(`${context}: disposition must use native unquoted tokens.`);
    if (children(symbol, "fields_autoplaced").some(node => node.values.length !== 0 || node.children.length !== 0)) throw new FreshKicadParseError(`${context}: malformed fields_autoplaced marker.`);
    if (component.symbolLibId !== "power:PWR_FLAG" || component.unit !== 1 || component.bodyStyle !== 1
      || component.symbolUuid === null || allUuids.filter(uuid => uuid === component.symbolUuid).length !== 1
      || terminalScalar(symbol, "in_bom", context) !== "yes" || terminalScalar(symbol, "on_board", context) !== "yes") throw new FreshKicadParseError(`${context}: unsupported power instance identity or disposition.`);
    for (const name of ["dnp", "exclude_from_sim"]) if (children(symbol, name).length > 0 && terminalScalar(symbol, name, context) !== "no") throw new FreshKicadParseError(`${context}: excluded power instance is unsupported.`);
    const properties = terminalProperties(symbol, context);
    if (properties.get("Reference") !== component.reference || properties.get("Value") !== "PWR_FLAG" || properties.get("Footprint") !== ""
      || [...properties.keys()].some(name => !["Reference", "Value", "Footprint", "Datasheet", "Description"].includes(name))) throw new FreshKicadParseError(`${context}: exact stock power fields or empty footprint changed.`);
    const pins = children(symbol, "pin");
    if (pins.length > 1 || pins.length === 1 && (pins[0]!.values.length !== 1 || pins[0]!.values[0]!.value !== "1"
      || itemIdentity(pins[0]!, context) === null || allUuids.filter(uuid => uuid === itemIdentity(pins[0]!, context)).length !== 1)) throw new FreshKicadParseError(`${context}: optional instance pin metadata must contain one unique pin 1.`);
    const instances = terminalField(symbol, "instances", context)!;
    if (instances.values.length !== 0 || instances.children.length !== 1 || instances.children[0]!.name !== "project") throw new FreshKicadParseError(`${context}: unsupported instance project inventory.`);
    const project = instances.children[0]!;
    if (project.values.length !== 1 || project.children.length !== 1 || project.children[0]!.name !== "path") throw new FreshKicadParseError(`${context}: unsupported instance path inventory.`);
    const instancePath = project.children[0]!;
    if (instancePath.values.length !== 1 || instancePath.values[0]!.value !== `/${rootUuid}` || instancePath.children.length !== 2
      || terminalScalar(instancePath, "reference", context) !== component.reference || terminalScalar(instancePath, "unit", context) !== "1") throw new FreshKicadParseError(`${context}: instance path/reference/unit differs from the root sheet.`);
    const fields = children(symbol, "property").map(field => {
      const offset = field.values[0]?.value === "private" && !field.values[0].quoted ? 1 : 0;
      const allowedProperty = new Set(["at", "effects", "hide", "show_name", "do_not_autoplace"]);
      if (field.children.some(child => !allowedProperty.has(child.name)) || [...allowedProperty].some(name => children(field, name).length > 1)) throw new FreshKicadParseError(`${context}: unsupported field rendering metadata.`);
      for (const name of ["show_name", "do_not_autoplace"]) if (children(field, name).length > 0 && (terminalScalar(field, name, context) !== "no" || children(field, name)[0]!.values[0]!.quoted)) throw new FreshKicadParseError(`${context}: unsupported field presentation flag.`);
      for (const effects of children(field, "effects")) {
        if (effects.values.length !== 0 || effects.children.some(child => !["font", "hide", "justify"].includes(child.name)) || ["font", "hide", "justify"].some(name => children(effects, name).length > 1)) throw new FreshKicadParseError(`${context}: unsupported field effects.`);
        for (const font of children(effects, "font")) if (font.values.length !== 0 || font.children.some(child => child.name !== "size") || children(font, "size").length !== 1) throw new FreshKicadParseError(`${context}: unsupported font face, stroke, or style.`);
      }
      return Object.freeze({ name: field.values[offset]!.value, text: field.values[offset + 1]!.value, presentation: schematicTextPresentation(field, context) });
    });
    return Object.freeze({ ...component, fields: Object.freeze(fields), instanceIdentity: terminalIdentity(source.slice(symbol.start, symbol.end)) });
  });
  return Object.freeze({ placed, auxiliary: Object.freeze(metadata), ...(metadata.length === 0 ? {} : { definitionSemanticIdentity: freshPowerFlagDefinitionSemanticIdentity(source, expectedIdentity, true) }) });
}

export interface FreshSchematicConnectivityPrimitiveInventory {
  readonly wires: readonly Readonly<{ uuid: string; start: FreshPoint; end: FreshPoint }>[];
  readonly globalLabels: readonly Readonly<{ uuid: string; name: string; at: FreshPoint; rotationDeg: number; shape: string; justify: readonly string[] | null }>[];
  readonly noConnects: readonly Readonly<{ uuid: string; at: FreshPoint }>[];
  readonly junctions: readonly Readonly<{ uuid: string; at: FreshPoint }>[];
  /** SHA-256/UTF-8 size of JSON.stringify(exact raw retained root-child spans in source order).
   * Only four primitive kinds are omitted; all other child contents/order remain byte-exact.
   * Separator whitespace outside child spans is intentionally not part of this projection.
   */
  readonly unrelatedChildrenIdentity: ContentIdentity;
}

/** Narrow source association for the host batch receipt; never normalizes/deduplicates geometry. */
export function parseFreshSchematicConnectivityPrimitiveInventory(source: string): FreshSchematicConnectivityPrimitiveInventory {
  const root = parseDocument(source, "kicad_sch");
  if (root.values.length !== 0) throw new FreshKicadParseError("Connectivity inventory root contains unexpected scalar metadata.");
  const kinds = new Set(["wire", "global_label", "no_connect", "junction"]);
  const allIds: string[] = [];
  for (const field of descendants(root, "uuid")) {
    if (field.children.length !== 0 || field.values.length !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(field.values[0]!.value)) {
      throw new FreshKicadParseError("Connectivity inventory contains malformed native UUID metadata.");
    }
    allIds.push(field.values[0]!.value);
  }
  if (new Set(allIds).size !== allIds.length) throw new FreshKicadParseError("Connectivity inventory contains duplicate native UUIDs.");
  const exactId = (node: Node): string => {
    const id = itemIdentity(node, `Connectivity ${node.name}`);
    if (id === null || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) throw new FreshKicadParseError(`Connectivity ${node.name} lacks a canonical UUID.`);
    return id;
  };
  const exactPoint = (node: Node): FreshPoint => {
    const at = one(node, "at");
    const result = point(node, "at");
    if (result === null || at === null || at.values.length !== 2 || at.children.length !== 0 || at.values.some(value => value.quoted)) throw new FreshKicadParseError(`Connectivity ${node.name} position is malformed.`);
    return Object.freeze(result);
  };
  const assertChildren = (node: Node, allowed: readonly string[]): void => {
    if (node.values.length !== 0 || node.children.some(child => !allowed.includes(child.name)) || new Set(node.children.map(child => child.name)).size !== node.children.length) throw new FreshKicadParseError(`Connectivity ${node.name} fields are malformed or unsupported.`);
  };
  const wires = children(root, "wire").map(wire => {
    assertChildren(wire, ["pts", "stroke", "uuid"]);
    const points = one(wire, "pts"), vertices = points === null ? [] : children(points, "xy");
    if (points === null || points.values.length !== 0 || points.children.length !== 2 || vertices.length !== 2) throw new FreshKicadParseError("Connectivity wire needs exactly two source points.");
    const tuples = vertices.map(vertex => {
      const x = number(vertex.values[0]?.value), y = number(vertex.values[1]?.value);
      if (x === null || y === null || vertex.values.length !== 2 || vertex.children.length !== 0 || vertex.values.some(value => value.quoted)) throw new FreshKicadParseError("Connectivity wire point is malformed.");
      return Object.freeze({ x, y });
    });
    return Object.freeze({ uuid: exactId(wire), start: tuples[0]!, end: tuples[1]! });
  });
  const globalLabels = children(root, "global_label").map(label => {
    const text = schematicTextPresentation(label, "Connectivity global label");
    const shape = scalar(label, "shape");
    if (label.values.length !== 1 || label.values[0]!.value.length === 0 || text.at === null || text.rotationDeg === null || shape === null
        || label.children.some(child => child.start < label.values[0]!.end)) throw new FreshKicadParseError("Connectivity global label has malformed name/position/shape.");
    return Object.freeze({ uuid: exactId(label), name: label.values[0]!.value, at: text.at, rotationDeg: text.rotationDeg, shape, justify: text.justify });
  });
  const noConnects = children(root, "no_connect").map(node => { assertChildren(node, ["at", "uuid"]); return Object.freeze({ uuid: exactId(node), at: exactPoint(node) }); });
  const junctions = children(root, "junction").map(node => { assertChildren(node, ["at", "diameter", "color", "uuid"]); return Object.freeze({ uuid: exactId(node), at: exactPoint(node) }); });
  const retained = JSON.stringify(root.children.filter(child => !kinds.has(child.name)).map(child => source.slice(child.start, child.end)));
  return Object.freeze({ wires: Object.freeze(wires), globalLabels: Object.freeze(globalLabels), noConnects: Object.freeze(noConnects), junctions: Object.freeze(junctions),
    unrelatedChildrenIdentity: Object.freeze({ algorithm: "sha256", digest: createHash("sha256").update(retained, "utf8").digest("hex"), size: Buffer.byteLength(retained, "utf8") }) });
}

export interface FreshSchematicBodyGraphic {
  readonly kind: string;
  /** SHA-256 of JSON-encoded exact raw tokens: whitespace is excluded, strings/spelling/order are not. */
  readonly tokenIdentity: ContentIdentity;
  readonly sourceIdentity: ContentIdentity;
  /** Parsed path/control geometry only, before any source or renderer stroke expansion. */
  readonly centerlineBounds: Readonly<{ minXmm: number; minYmm: number; maxXmm: number; maxYmm: number }> | null;
  /** null means omitted; zero means explicit native-default selection. Neither is a measured width. */
  readonly sourceStrokeWidthMm: number | null;
  readonly bounds: Readonly<{ minXmm: number; minYmm: number; maxXmm: number; maxYmm: number }> | null;
  readonly unsupportedReason: string | null;
}

function terminalBodyGraphic(source: string, node: Node): FreshSchematicBodyGraphic {
  const rawTokens: string[] = [];
  const visit = (entry: Node): void => {
    rawTokens.push("(", entry.name);
    for (const child of [...entry.values, ...entry.children].sort((left, right) => left.start - right.start)) {
      if ("children" in child) visit(child); else rawTokens.push(source.slice(child.start, child.end));
      if (rawTokens.length > MAX_NODES) throw new FreshKicadParseError("Terminal graphic raw-token inventory exceeds its bound.");
    }
    rawTokens.push(")");
  };
  visit(node);
  const identities = { tokenIdentity: terminalIdentity(JSON.stringify(rawTokens)), sourceIdentity: terminalIdentity(source.slice(node.start, node.end)) };
  let sourceStrokeWidthMm: number | null = null;
  const unsupported = (reason: string): FreshSchematicBodyGraphic => Object.freeze({ kind: node.name, ...identities, centerlineBounds: null, sourceStrokeWidthMm, bounds: null, unsupportedReason: reason });
  if (["text", "text_box"].includes(node.name)) return unsupported("graphic-text-requires-native-font");
  if (!["rectangle", "polyline", "circle", "arc", "bezier"].includes(node.name)) return unsupported(`unsupported-graphic:${node.name}`);
  if (node.values.length !== 0) return unsupported("unsupported-graphic-modifier");
  const context = `Terminal body ${node.name}`;
  const strictPoint = (owner: Node, field: string): Readonly<{ x: number; y: number }> => {
    const child = terminalField(owner, field, context)!;
    const x = child.values[0]?.quoted ? null : number(child.values[0]?.value);
    const y = child.values[1]?.quoted ? null : number(child.values[1]?.value);
    if (child.values.length !== 2 || child.children.length !== 0 || x === null || y === null || Math.abs(x) > 2000 || Math.abs(y) > 2000) {
      throw new FreshKicadParseError(`${context}: malformed coordinate.`);
    }
    return { x, y };
  };
  const stroke = terminalField(node, "stroke", context, true);
  if (stroke !== null) {
    if (stroke.values.length !== 0 || stroke.children.some((child) => !["width", "type", "color"].includes(child.name))) return unsupported("unsupported-stroke-metadata");
    const width = terminalField(stroke, "width", context, true);
    if (width !== null) {
      sourceStrokeWidthMm = width.values[0]?.quoted ? null : number(width.values[0]?.value);
      if (width.values.length !== 1 || width.children.length !== 0 || sourceStrokeWidthMm === null || sourceStrokeWidthMm < 0 || sourceStrokeWidthMm > 100) throw new FreshKicadParseError(`${context}: malformed stroke width.`);
    }
  }
  // Positive source stroke width is bound. Dash/color/fill can remove ink but cannot extend this envelope.
  if (stroke !== null) for (const name of ["type", "color"]) terminalField(stroke, name, context, true);
  const fill = terminalField(node, "fill", context, true);
  if (fill !== null && (fill.values.length !== 0 || fill.children.some((child) => !["type", "color"].includes(child.name)))) return unsupported("unsupported-fill-metadata");
  if (fill !== null) for (const name of ["type", "color"]) terminalField(fill, name, context, true);
  const allowed = new Set(["stroke", "fill", "uuid", ...(node.name === "rectangle" ? ["start", "end"]
    : node.name === "circle" ? ["center", "radius"] : node.name === "arc" ? ["start", "mid", "end"] : ["pts"])]);
  if (node.children.some((child) => !allowed.has(child.name))) return unsupported("unsupported-graphic-metadata");
  itemIdentity(node, context);
  let minX: number; let minY: number; let maxX: number; let maxY: number;
  if (node.name === "rectangle") {
    const start = strictPoint(node, "start"); const end = strictPoint(node, "end");
    minX = Math.min(start.x, end.x); maxX = Math.max(start.x, end.x); minY = Math.min(start.y, end.y); maxY = Math.max(start.y, end.y);
  } else if (node.name === "circle") {
    const center = strictPoint(node, "center");
    const radius = terminalField(node, "radius", context)!;
    const radiusMm = radius.values[0]?.quoted ? null : number(radius.values[0]?.value);
    if (radius.values.length !== 1 || radius.children.length !== 0 || radiusMm === null || radiusMm <= 0 || radiusMm > 2000) throw new FreshKicadParseError(`${context}: malformed circle radius.`);
    minX = center.x - radiusMm; maxX = center.x + radiusMm; minY = center.y - radiusMm; maxY = center.y + radiusMm;
  } else if (node.name === "arc") {
    const a = strictPoint(node, "start"); const b = strictPoint(node, "mid"); const c = strictPoint(node, "end");
    const bx = b.x - a.x; const by = b.y - a.y; const cx = c.x - a.x; const cy = c.y - a.y;
    const determinant = 2 * (bx * cy - by * cx);
    const scaleSquared = Math.max(bx * bx + by * by, cx * cx + cy * cy, 1);
    // A full circumcircle conservatively contains either sweep. Degenerate/unstable arcs need native evidence.
    if (Math.abs(determinant) < scaleSquared * 0.000_001) return unsupported("degenerate-or-unstable-arc");
    const bb = bx * bx + by * by; const cc = cx * cx + cy * cy;
    const x = a.x + (bb * cy - cc * by) / determinant;
    const y = a.y + (bx * cc - cx * bb) / determinant;
    const radius = Math.max(Math.hypot(a.x - x, a.y - y), Math.hypot(b.x - x, b.y - y), Math.hypot(c.x - x, c.y - y));
    if (!Number.isFinite(radius) || radius > 2000 || Math.abs(x) > 2000 || Math.abs(y) > 2000) return unsupported("out-of-bounds-arc");
    minX = x - radius; maxX = x + radius; minY = y - radius; maxY = y + radius;
  } else {
    const pts = terminalField(node, "pts", context)!;
    if (pts.values.length !== 0 || pts.children.length < 2 || pts.children.length > 256 || pts.children.some((child) => child.name !== "xy")
        || (node.name === "bezier" && pts.children.length !== 4)) throw new FreshKicadParseError(`${context}: malformed point inventory.`);
    const points = pts.children.map((child) => strictPoint({ ...pts, children: [child] }, "xy"));
    // A Bezier lies in its control-point convex hull. Polyline segments lie in their endpoint hull.
    minX = Math.min(...points.map((p) => p.x)); maxX = Math.max(...points.map((p) => p.x));
    minY = Math.min(...points.map((p) => p.y)); maxY = Math.max(...points.map((p) => p.y));
  }
  const centerlineBounds = Object.freeze({ minXmm: minX, minYmm: minY, maxXmm: maxX, maxYmm: maxY });
  if (Object.values(centerlineBounds).some((value) => !Number.isFinite(value) || Math.abs(value) > 2000)) return unsupported("graphic-bounds-out-of-envelope");
  if (sourceStrokeWidthMm === null || sourceStrokeWidthMm === 0) {
    return Object.freeze({ kind: node.name, ...identities, centerlineBounds, sourceStrokeWidthMm, bounds: null, unsupportedReason: "source-default-stroke-width-unbound" });
  }
  // Source-only envelope; native minimum-width expansion requires separately bound style evidence.
  const margin = sourceStrokeWidthMm + 0.001;
  const bounds = Object.freeze({ minXmm: minX - margin, minYmm: minY - margin, maxXmm: maxX + margin, maxYmm: maxY + margin });
  if (Object.values(bounds).some((value) => !Number.isFinite(value) || Math.abs(value) > 2000)) return unsupported("graphic-bounds-out-of-envelope");
  return Object.freeze({ kind: node.name, ...identities, centerlineBounds, sourceStrokeWidthMm, bounds, unsupportedReason: null });
}

/** Selected graphics only; fields, pin names/numbers and global/local labels are not measured here. */
export function selectFreshSymbolBodyGeometry(geometry: FreshSymbolTerminalGeometry, unit: number, bodyStyle: 1 | 2): readonly FreshSchematicBodyGraphic[] {
  selectFreshSymbolTerminalGeometryPins(geometry, unit, bodyStyle);
  return Object.freeze([
    ...(unit === 1 && bodyStyle === 1 ? geometry.rootGraphics : []),
    ...geometry.representations.filter((entry) => (entry.unit === 0 || entry.unit === unit) && (entry.bodyStyle === 0 || entry.bodyStyle === bodyStyle)).flatMap((entry) => entry.graphics),
  ]);
}

export type FreshStackupObservationStatus = "explicit" | "missing" | "unsupported";
export interface FreshStackupField<Value> {
  readonly status: FreshStackupObservationStatus;
  readonly value: Value | null;
  /** All original field forms, including duplicates or unsupported values. */
  readonly sources: readonly string[];
}
export interface FreshStackupSublayer {
  readonly index: number;
  readonly thicknessMm: FreshStackupField<number>;
  readonly thicknessLocked: FreshStackupField<boolean>;
  readonly material: FreshStackupField<string>;
  readonly epsilonR: FreshStackupField<number>;
  readonly lossTangent: FreshStackupField<number>;
  readonly color: FreshStackupField<string>;
  readonly unknownForms: readonly string[];
}
export interface FreshStackupLayer {
  readonly index: number;
  readonly name: string | null;
  readonly kind: "copper" | "dielectric" | "mask" | "paste" | "silkscreen" | "unsupported";
  readonly type: FreshStackupField<string>;
  readonly sublayers: readonly FreshStackupSublayer[];
  readonly source: string;
}
export interface FreshPcbStackup {
  readonly schemaVersion: "evleda.fresh-pcb-stackup.v1";
  /** Explicit means present and decoded, not complete electrical or fabrication evidence. */
  readonly status: FreshStackupObservationStatus;
  readonly observationsComplete: boolean;
  readonly boardVersion: number | null;
  readonly generalBoardThicknessMm: FreshStackupField<number>;
  readonly boardCopperLayerOrder: readonly string[];
  readonly layers: readonly FreshStackupLayer[];
  readonly settings: readonly Readonly<{ name: string; source: string }>[];
  readonly unknownForms: readonly string[];
  readonly issues: readonly string[];
  readonly stackupSource: string | null;
}

/**
 * Physical source observations only. Reuses this module's bounded, span-aware parser.
 * KiCad 10.0.3 parseBoardStackup handles bare addsublayer separators and thickness locked:
 * https://gitlab.com/kicad/code/kicad/-/blob/10.0.3/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp
 * No material, epsilon_r, reference plane, or dielectric-height default is supplied.
 */
export function parseFreshPcbStackup(source: string): FreshPcbStackup {
  const issues: string[] = [];
  const raw = (entry: SourceSpan): string => source.slice(entry.start, entry.end);
  const freeze = <Value>(value: Value): Value => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const missing = <Value>(): FreshStackupField<Value> => ({ status: "missing", value: null, sources: [] });
  const field = <Value>(nodes: readonly Node[], name: string, decode: (node: Node) => Value | null): FreshStackupField<Value> => {
    const matches = nodes.filter(node => node.name === name);
    if (matches.length === 0) return missing<Value>();
    const value = matches.length === 1 ? decode(matches[0]!) : null;
    if (value === null) issues.push(`Unsupported or duplicate ${name} field at source offset ${matches[0]!.start}.`);
    return { status: value === null ? "unsupported" : "explicit", value, sources: matches.map(raw) };
  };
  const numeric = (node: Node, allowLock = false): number | null => {
    if (node.children.length !== 0 || node.values.length < 1 || node.values.length > (allowLock ? 2 : 1)) return null;
    const atom = node.values[0]!;
    if (atom.quoted || !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u.test(atom.value)) return null;
    if (node.values.length === 2 && (node.values[1]!.quoted || node.values[1]!.value !== "locked")) return null;
    const result = Number(atom.value);
    return Number.isFinite(result) && result >= 0 && result <= 10_000_000 ? result : null;
  };
  const text = (node: Node): string | null => node.children.length === 0 && node.values.length === 1 ? node.values[0]!.value : null;
  const base = {
    schemaVersion: "evleda.fresh-pcb-stackup.v1" as const,
    boardVersion: null as number | null,
    generalBoardThicknessMm: missing<number>(), boardCopperLayerOrder: [] as string[],
    layers: [] as FreshStackupLayer[], settings: [] as { name: string; source: string }[],
    unknownForms: [] as string[], issues, stackupSource: null as string | null,
  };
  let root: Node;
  try { root = parseDocument(source, "kicad_pcb"); }
  catch (error) {
    if (!(error instanceof FreshKicadParseError)) throw error;
    issues.push(error.message);
    return freeze({ ...base, status: "unsupported", observationsComplete: false });
  }
  base.boardVersion = versionNumber(scalar(root, "version"));
  if (![20250316, 20260206].includes(base.boardVersion ?? 0)) issues.push("PCB format version is outside the inspected stackup grammar.");
  const general = children(root, "general");
  if (general.length > 1) issues.push("Multiple general forms make board thickness ambiguous.");
  base.generalBoardThicknessMm = field(general.flatMap(node => node.children), "thickness", node => numeric(node));
  const layerTables = children(root, "layers");
  if (layerTables.length !== 1) issues.push("Exactly one board layer table is required to compare copper order.");
  for (const entry of layerTables.flatMap(node => node.children)) {
    const name = entry.values[0]?.value;
    if (name?.endsWith(".Cu")) base.boardCopperLayerOrder.push(name);
  }
  const setups = children(root, "setup");
  const stacks = setups.flatMap(setup => children(setup, "stackup"));
  if (setups.length > 1 || stacks.length > 1) issues.push("Multiple setup/stackup forms are unsupported; no stack is selected.");
  if (stacks.length !== 1 || setups.length > 1) {
    base.unknownForms.push(...stacks.map(raw));
    return freeze({ ...base, status: issues.length > 0 ? "unsupported" : "missing", observationsComplete: stacks.length === 0 });
  }
  const stack = stacks[0]!;
  base.stackupSource = raw(stack);
  // Match native's bounded top-level inventory; do not truncate a source into an apparent pass.
  if (base.stackupSource.length > 1024 * 1024 || children(stack, "layer").length > 128) {
    issues.push("Physical stackup exceeds the supported 1 MiB / 128-layer observation bound.");
    base.stackupSource = null;
    return freeze({ ...base, status: "unsupported", observationsComplete: false });
  }
  const settings = new Set(["copper_finish", "dielectric_constraints", "edge_connector", "castellated_pads", "edge_plating"]);
  const seenSettings = new Set<string>();
  for (const child of stack.children.filter(node => node.name !== "layer")) {
    base.settings.push({ name: child.name, source: raw(child) });
    const acceptedValue = child.name === "copper_finish" || child.name === "edge_connector"
      ? child.name === "copper_finish" || ["yes", "no", "bevelled"].includes(child.values[0]?.value ?? "")
      : ["yes", "no"].includes(child.values[0]?.value ?? "");
    if (!settings.has(child.name) || child.children.length !== 0 || child.values.length !== 1 || !acceptedValue || seenSettings.has(child.name)) {
      base.unknownForms.push(raw(child)); issues.push(`Unsupported or duplicate stackup setting ${child.name}.`);
    }
    seenSettings.add(child.name);
  }
  if (stack.values.length > 0) { base.unknownForms.push(...stack.values.map(raw)); issues.push("Unsupported bare stackup tokens."); }
  const seenLayers = new Set<string>();
  for (const [index, node] of children(stack, "layer").entries()) {
    const nameAtom = node.values[0];
    const name = nameAtom?.value ?? null;
    const kind: FreshStackupLayer["kind"] = name === "F.Cu" || name === "B.Cu" || /^In(?:[1-9]|[12]\d|30)\.Cu$/u.test(name ?? "") ? "copper"
      : /^(?:F|B)\.Mask$/u.test(name ?? "") ? "mask"
      : /^(?:F|B)\.Paste$/u.test(name ?? "") ? "paste"
      : /^(?:F|B)\.SilkS$/u.test(name ?? "") ? "silkscreen"
      : /^dielectric [1-9]\d*$/u.test(name ?? "") ? "dielectric" : "unsupported";
    if (name === null || kind === "unsupported" || seenLayers.has(name)
        || (node.children[0] !== undefined && nameAtom!.start > node.children[0].start)) issues.push(`Unsupported or repeated stackup layer at index ${index}.`);
    if (name !== null) seenLayers.add(name);
    const groups: Node[][] = [[]];
    const unknownByGroup: string[][] = [[]];
    const entries = [
      ...node.children.map(child => ({ entry: child, child: true })),
      ...node.values.slice(1).map(atom => ({ entry: atom, child: false })),
    ].sort((left, right) => left.entry.start - right.entry.start);
    for (const entry of entries) {
      if (entry.child) groups[groups.length - 1]!.push(entry.entry as Node);
      else if (!(entry.entry as Atom).quoted && (entry.entry as Atom).value === "addsublayer") {
        if (kind !== "dielectric") issues.push(`addsublayer on non-dielectric layer ${name}.`);
        groups.push([]); unknownByGroup.push([]);
      } else { unknownByGroup[groups.length - 1]!.push(raw(entry.entry)); issues.push(`Unsupported bare layer token on ${name}.`); }
    }
    if (groups.length > 128) {
      issues.push(`Layer ${name} exceeds 128 supported sublayers; exact layer source is retained.`);
      base.layers.push({ index, name, kind, type: field(node.children, "type", text), sublayers: [], source: raw(node) });
      continue;
    }
    const type = field(node.children, "type", text);
    const sublayers = groups.map((nodes, subIndex): FreshStackupSublayer => {
      const unknownForms = unknownByGroup[subIndex]!;
      for (const child of nodes) if (!["type", "thickness", "material", "epsilon_r", "loss_tangent", "color"].includes(child.name)) {
        unknownForms.push(raw(child)); issues.push(`Unsupported layer field ${child.name} on ${name}.`);
      }
      if (nodes.length === 0 && subIndex > 0) issues.push(`Empty added dielectric sublayer on ${name}.`);
      const thicknessMm = field(nodes, "thickness", child => numeric(child, kind === "dielectric"));
      const thickness = nodes.filter(child => child.name === "thickness");
      const thicknessLocked: FreshStackupField<boolean> = thicknessMm.status === "unsupported"
        ? { status: "unsupported", value: null, sources: thickness.map(raw) }
        : thickness.length === 1 && thickness[0]!.values.length === 2
          ? { status: "explicit", value: true, sources: thickness.map(raw) } : missing<boolean>();
      return { index: subIndex, thicknessMm, thicknessLocked,
        material: field(nodes, "material", text), epsilonR: field(nodes, "epsilon_r", child => numeric(child)),
        lossTangent: field(nodes, "loss_tangent", child => numeric(child)), color: field(nodes, "color", text), unknownForms };
    });
    base.layers.push({ index, name, kind, type, sublayers, source: raw(node) });
  }
  const physicalCopper = base.layers.filter(layer => layer.kind === "copper").map(layer => layer.name!);
  if (physicalCopper.length < 2 || JSON.stringify(physicalCopper) !== JSON.stringify(base.boardCopperLayerOrder)) issues.push("Physical-stackup copper order differs from the board layer table or has fewer than two copper layers.");
  return freeze({ ...base, status: issues.length > 0 ? "unsupported" : "explicit", observationsComplete: base.layers.every(layer => layer.sublayers.length > 0) });
}

export interface FreshReferencePointNm { readonly x: number; readonly y: number }
export interface FreshReferenceSourceObservation {
  readonly kind: string;
  readonly source: string;
  readonly sourceIdentity: ContentIdentity;
  readonly reason: string;
}
export interface FreshReferenceSegment {
  readonly uuid: string;
  readonly netName: string | null;
  readonly layer: string;
  readonly startNm: FreshReferencePointNm;
  readonly endNm: FreshReferencePointNm;
  readonly widthNm: number;
  readonly source: string;
  readonly sourceIdentity: ContentIdentity;
}
export interface FreshReferenceSetting {
  readonly name: string;
  readonly values: readonly Readonly<{ value: string; quoted: boolean }>[];
  readonly children: readonly FreshReferenceSetting[];
  readonly quantityNm: number | null;
  readonly source: string;
}
export interface FreshReferenceContour {
  readonly status: "supported" | "unsupported";
  /** The complete ordered chain, including repeated fracture/bridge vertices. No hole inference. */
  readonly pointsNm: readonly FreshReferencePointNm[] | null;
  readonly source: string;
  readonly unknownForms: readonly string[];
}
export interface FreshReferencePolygonGroup {
  readonly index: number;
  readonly status: "supported" | "unsupported";
  readonly layer: string | null;
  readonly islandFlag: Readonly<{ status: "explicit" | "omitted" | "unsupported"; value: boolean | null; source: string | null }>;
  /** Keep every pts group inside this source polygon together; never union individual vertices. */
  readonly contourGroup: readonly FreshReferenceContour[];
  readonly source: string;
  readonly unknownForms: readonly string[];
  readonly issues: readonly string[];
}
export interface FreshReferenceZone {
  readonly index: number;
  readonly status: "supported" | "unsupported";
  readonly uuid: string | null;
  readonly netName: string | null;
  readonly layers: readonly string[];
  readonly kind: "copper" | "rule_area" | "non_copper" | "unsupported";
  readonly settings: readonly FreshReferenceSetting[];
  readonly outlinePolygons: readonly FreshReferencePolygonGroup[];
  readonly filledPolygons: readonly FreshReferencePolygonGroup[];
  /** Source cache presence only; fill yes and cached polygons do not prove freshness. */
  readonly filledCachePresent: boolean;
  readonly source: string;
  readonly sourceIdentity: ContentIdentity;
  readonly unknownForms: readonly string[];
  readonly issues: readonly string[];
}
export interface FreshPcbReferenceGeometry {
  readonly schemaVersion: "evleda.fresh-pcb-reference-geometry.v1";
  readonly sourceIdentity: ContentIdentity;
  readonly boardVersion: number | null;
  readonly status: "observed" | "unsupported";
  readonly segments: readonly FreshReferenceSegment[];
  readonly zones: readonly FreshReferenceZone[];
  readonly unsupportedRouteItems: readonly FreshReferenceSourceObservation[];
  readonly otherObservations: readonly FreshReferenceSourceObservation[];
  readonly issues: readonly string[];
  readonly coverage: Readonly<{
    coordinateUnits: "nm";
    filledContours: "saved-fractured-contour-groups";
    fillCacheFreshness: "unverified";
    dcConnectivity: "not_evaluated";
    fullBoardGeometry: false;
  }>;
}

/**
 * Exact decimal source to integer nanometres. Do not round sub-nm values or accept
 * numbers KiCad 10.0.3 parseBoardUnits would clamp (INT_MAX - 10 nanometres).
 */
function freshReferenceNm(atom: Atom | undefined): number | null {
  if (atom === undefined || atom.quoted || atom.value.length > 128) return null;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(atom.value);
  if (match === null || (match[2]!.length === 0 && (match[3]?.length ?? 0) === 0)) return null;
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  let integer = BigInt((match[2]! + (match[3] ?? "")) || "0");
  const power = 6 + exponent - (match[3]?.length ?? 0);
  if (power >= 0) integer *= 10n ** BigInt(power);
  else {
    const divisor = 10n ** BigInt(-power);
    if (integer % divisor !== 0n) return null;
    integer /= divisor;
  }
  if (match[1] === "-") integer = -integer;
  if (integer < -2147483637n || integer > 2147483637n) return null;
  return Number(integer);
}

/**
 * Saved source only, using the shared bounded parser and net resolver. Native grammar:
 * https://gitlab.com/kicad/code/kicad/-/blob/10.0.3/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp#L7653
 * A filled_polygon is a fractured chain; it must not be interpreted as a hole-free polygon.
 */
export function parseFreshPcbReferenceGeometry(source: string): FreshPcbReferenceGeometry {
  const root = parseDocument(source, "kicad_pcb");
  const raw = (node: SourceSpan): string => source.slice(node.start, node.end);
  const identity = (text: string): ContentIdentity => ({ algorithm: "sha256", digest: createHash("sha256").update(text, "utf8").digest("hex"), size: Buffer.byteLength(text, "utf8") });
  const freeze = <Value>(value: Value): Value => {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  const issues: string[] = [];
  const boardVersion = versionNumber(scalar(root, "version"));
  if (![20250316, 20260206].includes(boardVersion ?? 0)) issues.push("PCB version is outside the inspected reference-geometry grammar.");
  if (children(root, "segment").length > 8192 || children(root, "zone").length > 512) throw new FreshKicadParseError("Reference geometry exceeds the bounded 8192-segment / 512-zone inventory.");
  const uuidCounts = new Map<string, number>();
  for (const node of [...descendants(root, "uuid"), ...descendants(root, "tstamp")]) {
    if (node.values.length !== 1 || node.children.length !== 0) { issues.push("Malformed source object identity field."); continue; }
    const value = node.values[0]!.value.toLowerCase();
    uuidCounts.set(value, (uuidCounts.get(value) ?? 0) + 1);
  }
  if ([...uuidCounts.values()].some(count => count > 1)) issues.push("Repeated UUID/tstamp identities exist in the saved source.");
  const uuid = (node: Node): string => {
    const value = itemIdentity(node, node.name);
    if (value === null || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) || uuidCounts.get(value.toLowerCase()) !== 1) throw new FreshKicadParseError("A unique complete UUID is required for reference geometry.");
    return value;
  };
  let resolveNet: ReturnType<typeof freshPcbNetResolver> | null = null;
  try { resolveNet = freshPcbNetResolver(root); }
  catch (error) { if (!(error instanceof FreshKicadParseError)) throw error; issues.push(error.message); }
  if (children(root, "net").some(node => node.children.length !== 0)) { resolveNet = null; issues.push("Unknown fields in the legacy net table are not discarded."); }
  const copperLayer = (name: string): boolean => name === "F.Cu" || name === "B.Cu" || /^In(?:[1-9]|[12]\d|30)\.Cu$/u.test(name);
  const layerTables = children(root, "layers");
  const declaredLayers = new Set(layerTables.flatMap(table => table.children.map(node => node.values[0]?.value ?? "")));
  if (layerTables.length !== 1 || declaredLayers.has("")) issues.push("Board layer inventory is missing or ambiguous.");
  const net = (node: Node): string | null => {
    const fields = children(node, "net");
    if (resolveNet === null || fields.length !== 1) throw new FreshKicadParseError("One exact net reference and a valid net table are required.");
    const name = resolveNet(fields[0]!);
    const legacyNames = children(node, "net_name");
    if (legacyNames.length > 0 && (legacyNames.length !== 1 || scalar(node, "net_name") !== (name ?? ""))) throw new FreshKicadParseError("Zone net_name disagrees with its exact net reference.");
    return name;
  };
  const layerNames = (node: Node): string[] => {
    const fields = node.children.filter(child => child.name === "layer" || child.name === "layers");
    if (fields.length !== 1 || fields[0]!.children.length !== 0 || fields[0]!.values.length === 0
        || fields[0]!.name === "layer" && fields[0]!.values.length !== 1) throw new FreshKicadParseError("Layer selection is missing, repeated or malformed.");
    const names = fields[0]!.values.map(atom => atom.value);
    if (layerTables.length !== 1 || new Set(names).size !== names.length || names.some(name => name.includes("*") || name.length === 0 || !declaredLayers.has(name))) throw new FreshKicadParseError("Wildcard, undeclared, empty or repeated layer selections are not resolved by this reader.");
    return names;
  };
  const pointNm = (node: Node): FreshReferencePointNm => {
    const x = freshReferenceNm(node.values[0]), y = freshReferenceNm(node.values[1]);
    if (node.children.length !== 0 || node.values.length !== 2 || x === null || y === null) throw new FreshKicadParseError("Point is not exactly representable in supported integer nanometres.");
    return { x, y };
  };
  const exactField = (node: Node, name: string): Node => {
    const fields = children(node, name);
    if (fields.length !== 1) throw new FreshKicadParseError(`Exactly one ${name} field is required.`);
    return fields[0]!;
  };
  const observation = (node: Node, reason: string): FreshReferenceSourceObservation => ({ kind: node.name, source: raw(node), sourceIdentity: identity(raw(node)), reason });
  const segments: FreshReferenceSegment[] = [];
  const unsupportedRouteItems: FreshReferenceSourceObservation[] = [];
  for (const node of root.children.filter(child => ["segment", "arc", "via"].includes(child.name))) {
    if (node.name !== "segment") { unsupportedRouteItems.push(observation(node, `${node.name} is preserved but not straight-segment reference geometry.`)); continue; }
    try {
      const unknown = node.children.filter(child => !["start", "end", "width", "layer", "net", "uuid", "tstamp", "locked", "status"].includes(child.name));
      if (unknown.length > 0 || node.values.length > 0) throw new FreshKicadParseError("Segment contains unsupported source fields or tokens.");
      const startNm = pointNm(exactField(node, "start")), endNm = pointNm(exactField(node, "end"));
      const width = exactField(node, "width"), widthNm = freshReferenceNm(width.values[0]);
      const layers = layerNames(node);
      if (width.children.length !== 0 || width.values.length !== 1 || widthNm === null || widthNm <= 0 || layers.length !== 1 || !copperLayer(layers[0]!)
          || startNm.x === endNm.x && startNm.y === endNm.y) throw new FreshKicadParseError("Segment has unsupported width, layer, or zero-length geometry.");
      segments.push({ uuid: uuid(node), netName: net(node), layer: layers[0]!, startNm, endNm, widthNm, source: raw(node), sourceIdentity: identity(raw(node)) });
    } catch (error) {
      if (!(error instanceof FreshKicadParseError)) throw error;
      unsupportedRouteItems.push(observation(node, error.message));
    }
  }
  let totalPoints = 0;
  const contour = (node: Node): FreshReferenceContour => {
    const unknownForms = node.children.filter(child => child.name !== "xy").map(raw);
    const xy = children(node, "xy");
    totalPoints += xy.length;
    if (xy.length > 65536 || totalPoints > 262144) throw new FreshKicadParseError("Reference contours exceed the bounded point inventory.");
    try {
      if (unknownForms.length > 0 || node.values.length > 0 || xy.length < 3) throw new FreshKicadParseError("Unsupported pts contour structure.");
      return { status: "supported", pointsNm: xy.map(pointNm), source: raw(node), unknownForms };
    } catch (error) {
      if (!(error instanceof FreshKicadParseError)) throw error;
      return { status: "unsupported", pointsNm: null, source: raw(node), unknownForms };
    }
  };
  const polygon = (node: Node, index: number, filled: boolean, zoneLayers: readonly string[]): FreshReferencePolygonGroup => {
    const localIssues: string[] = [];
    const unknownForms = node.children.filter(child => !(filled ? ["layer", "island", "pts"] : ["pts"]).includes(child.name)).map(raw);
    if (unknownForms.length > 0 || node.values.length > 0) localIssues.push("Unsupported polygon fields or bare tokens are retained.");
    let layer: string | null = null;
    if (filled) {
      try { const names = layerNames(node); if (names.length !== 1 || !zoneLayers.includes(names[0]!)) throw new FreshKicadParseError("Filled polygon layer differs from its zone."); layer = names[0]!; }
      catch (error) { if (!(error instanceof FreshKicadParseError)) throw error; localIssues.push(error.message); }
    }
    const islands = children(node, "island");
    let islandFlag: FreshReferencePolygonGroup["islandFlag"] = { status: "omitted", value: null, source: null };
    if (islands.length > 0) {
      const item = islands[0]!;
      const valid = islands.length === 1 && item.children.length === 0 && (item.values.length === 0
        || item.values.length === 1 && !item.values[0]!.quoted && ["yes", "no"].includes(item.values[0]!.value));
      islandFlag = { status: valid ? "explicit" : "unsupported", value: valid ? item.values.length === 0 || item.values[0]!.value === "yes" : null, source: islands.map(raw).join("\n") };
      if (!valid) localIssues.push("Unsupported island flag.");
    }
    const contourGroup = children(node, "pts").map(contour);
    if (contourGroup.length !== 1) localIssues.push("Pinned polygon grammar requires one complete pts group; all supplied groups are retained.");
    const expectedOrder = filled ? ["layer", ...(islands.length > 0 ? ["island"] : []), "pts"] : ["pts"];
    if (JSON.stringify(node.children.map(child => child.name)) !== JSON.stringify(expectedOrder)) localIssues.push("Polygon field order is outside the pinned grammar.");
    if (contourGroup.some(group => group.status !== "supported")) localIssues.push("Contour contains unsupported or unrepresentable vertices.");
    return { index, status: localIssues.length > 0 ? "unsupported" : "supported", layer, islandFlag, contourGroup, source: raw(node), unknownForms, issues: localIssues };
  };
  const lengthSettings = new Set(["clearance", "min_thickness", "thermal_gap", "thermal_bridge_width", "radius", "hatch_thickness", "hatch_gap"]);
  const setting = (node: Node, localIssues: string[]): FreshReferenceSetting => {
    let quantityNm: number | null = null;
    if (new Set(node.children.map(child => child.name)).size !== node.children.length) localIssues.push(`Repeated child settings inside ${node.name}.`);
    if (lengthSettings.has(node.name)) {
      quantityNm = node.children.length === 0 && node.values.length === 1 ? freshReferenceNm(node.values[0]) : null;
      if (quantityNm === null || quantityNm < 0) localIssues.push(`Setting ${node.name} is not a nonnegative representable nanometre quantity.`);
    }
    return { name: node.name, values: node.values.map(atom => ({ value: atom.value, quoted: atom.quoted })), children: node.children.map(child => setting(child, localIssues)), quantityNm, source: raw(node) };
  };
  const zoneFields = new Set(["net", "net_name", "layer", "layers", "uuid", "tstamp", "hatch", "priority", "connect_pads", "min_thickness", "fill", "polygon", "filled_polygon", "name", "keepout", "placement", "locked"]);
  const settingChildren: Readonly<Record<string, readonly string[]>> = {
    connect_pads: ["clearance"],
    fill: ["mode", "thermal_gap", "thermal_bridge_width", "smoothing", "radius", "island_removal_mode", "island_area_min", "hatch_thickness", "hatch_gap", "hatch_orientation", "hatch_smoothing_level", "hatch_smoothing_value", "hatch_border_algorithm", "hatch_min_hole_area"],
    keepout: ["tracks", "vias", "copperpour", "pads", "footprints"], placement: ["sheetname", "component_class", "group", "enabled"],
  };
  const zones = children(root, "zone").map((node, index): FreshReferenceZone => {
    const localIssues: string[] = [];
    let zoneUuid: string | null = null, netName: string | null = null, layers: string[] = [];
    try { zoneUuid = uuid(node); } catch (error) { if (!(error instanceof FreshKicadParseError)) throw error; localIssues.push(error.message); }
    try { netName = net(node); } catch (error) { if (!(error instanceof FreshKicadParseError)) throw error; localIssues.push(error.message); }
    try { layers = layerNames(node); } catch (error) { if (!(error instanceof FreshKicadParseError)) throw error; localIssues.push(error.message); }
    const kind = children(node, "keepout").length > 0 || children(node, "placement").length > 0 ? "rule_area"
      : layers.length === 0 ? "unsupported" : layers.every(copperLayer) ? "copper" : "non_copper";
    const unknownForms = node.children.filter(child => !zoneFields.has(child.name)).map(raw);
    if (node.values.length > 0) { unknownForms.push(...node.values.map(raw)); localIssues.push("Unsupported bare zone tokens."); }
    const seenSettings = new Set<string>();
    const settings = node.children.filter(child => !["net", "net_name", "layer", "layers", "uuid", "tstamp", "polygon", "filled_polygon"].includes(child.name)).map(child => {
      if (seenSettings.has(child.name)) localIssues.push(`Repeated zone setting ${child.name}.`);
      seenSettings.add(child.name);
      const allowed = settingChildren[child.name] ?? [];
      for (const nested of child.children) if (!allowed.includes(nested.name) || nested.children.length !== 0) unknownForms.push(raw(nested));
      return setting(child, localIssues);
    });
    if (unknownForms.length > 0) localIssues.push("Unknown zone fields are retained and cannot establish supported coverage.");
    const outlinePolygons = children(node, "polygon").map((entry, ordinal) => polygon(entry, ordinal, false, layers));
    const fills = children(node, "filled_polygon");
    if (fills.length > 4096) throw new FreshKicadParseError("Zone exceeds the bounded filled-polygon inventory.");
    const filledPolygons = fills.map((entry, ordinal) => polygon(entry, ordinal, true, layers));
    if ([...outlinePolygons, ...filledPolygons].some(group => group.status !== "supported")) localIssues.push("One or more zone contour groups are unsupported.");
    return { index, status: localIssues.length > 0 ? "unsupported" : "supported", uuid: zoneUuid, netName, layers, kind,
      settings, outlinePolygons, filledPolygons, filledCachePresent: fills.length > 0 || children(node, "fill_segments").length > 0, source: raw(node), sourceIdentity: identity(raw(node)), unknownForms, issues: localIssues };
  });
  const otherObservations: FreshReferenceSourceObservation[] = [];
  const knownMetadata = new Set(["version", "generator", "generator_version", "general", "paper", "layers", "setup", "property", "net", "embedded_fonts", "embedded_files", "group", "image"]);
  for (const node of root.children) {
    if (["segment", "arc", "via", "zone"].includes(node.name) || knownMetadata.has(node.name)) continue;
    if (node.name === "footprint") {
      otherObservations.push(observation(node, "Footprint-local pads/graphics are outside this top-level reference-geometry export."));
      for (const nested of [...descendants(node, "zone"), ...descendants(node, "segment"), ...descendants(node, "arc"), ...descendants(node, "via")]) {
        otherObservations.push(observation(nested, "Nested copper or rule geometry has a local coordinate frame and is unsupported here."));
        issues.push("Nested copper/rule geometry requires separate source-bound handling.");
      }
    } else if (!["gr_line", "gr_rect", "gr_arc", "gr_circle", "gr_poly", "gr_curve", "gr_text", "gr_text_box"].includes(node.name)
        || scalar(node, "layer") === null || scalar(node, "layer")?.endsWith(".Cu")) {
      otherObservations.push(observation(node, "Unmodeled or unknown board source geometry; no coverage pass is inferred."));
      issues.push(`Unmodeled board item ${node.name}.`);
    }
  }
  return freeze({ schemaVersion: "evleda.fresh-pcb-reference-geometry.v1", sourceIdentity: identity(source), boardVersion,
    status: issues.length > 0 || unsupportedRouteItems.length > 0 || zones.some(zone => zone.status !== "supported") ? "unsupported" : "observed",
    segments, zones, unsupportedRouteItems, otherObservations, issues,
    coverage: { coordinateUnits: "nm", filledContours: "saved-fractured-contour-groups", fillCacheFreshness: "unverified", dcConnectivity: "not_evaluated", fullBoardGeometry: false } });
}

export interface FreshPlaneRefillPreservationInput {
  readonly beforePcbSource: string;
  readonly afterPcbSource: string;
  /** Complete exact direct-board-zone inventory selected by the host, not a partial exclusion list. */
  readonly zoneUuids: readonly string[];
}

export interface FreshPlaneRefillZoneComparison {
  readonly uuid: string;
  readonly beforeFilledState: "omitted" | "no" | "yes";
  readonly afterFilledState: "yes";
  readonly filledStateTransition: "omitted-to-yes" | "no-to-yes" | "yes-to-yes";
  readonly beforeFilledPolygonCount: number;
  readonly afterFilledPolygonCount: number;
  /** Counts retain repeated vertices in native fractured contour chains. */
  readonly beforePointCount: number;
  readonly afterPointCount: number;
  /** Ordered raw cache tokens changed, modulo ASCII layout whitespace; not a freshness assertion. */
  readonly cacheChanged: boolean;
}

export interface FreshPlaneRefillPreservation {
  readonly schemaVersion: "evleda.fresh-plane-refill-preservation.v1";
  readonly equal: boolean;
  readonly beforeIdentity: ContentIdentity;
  readonly afterIdentity: ContentIdentity;
  readonly zoneUuids: readonly string[];
  readonly zones: readonly FreshPlaneRefillZoneComparison[];
  readonly changedZoneCount: number;
  readonly changedFilledStateZoneCount: number;
  readonly beforeFilledPolygonCount: number;
  readonly afterFilledPolygonCount: number;
  readonly fillCacheFreshness: "unverified";
  readonly dcConnectivity: "not_evaluated";
  readonly acceptanceEvaluated: false;
}

/**
 * Proves only non-cache source preservation across a refill attempt. It removes
 * validated direct selected zone filled_polygon spans and the leading derived
 * filled-state atom from comparison, then
 * applies the existing complete-board serializer equivalence to everything else.
 * The only state transitions admitted are omitted/no -> yes and yes -> yes.
 * Every after-zone must explicitly be filled. The existing fill container and
 * all its setting children, outlines, net/layer/UUID fields and all non-zone
 * geometry remain in the comparison. No cache, normalized text, or
 * comparison digest is returned as an authoritative persistence representation.
 * Initial support is solid, single-layer F.Cu/B.Cu zones; rule areas, nested
 * zones, fill_segments and unknown/malformed caches are rejected.
 */
export function compareFreshPlaneRefillPreservation(input: FreshPlaneRefillPreservationInput): FreshPlaneRefillPreservation {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (!Array.isArray(input.zoneUuids) || input.zoneUuids.length === 0 || input.zoneUuids.length > 512
      || input.zoneUuids.some((uuid, index) => !Object.hasOwn(input.zoneUuids, index) || typeof uuid !== "string" || !uuidPattern.test(uuid))
      || Object.keys(input.zoneUuids).length !== input.zoneUuids.length
      || new Set(input.zoneUuids).size !== input.zoneUuids.length) {
    throw new FreshKicadParseError("Refill preservation requires a bounded, unique, complete canonical zone UUID inventory.");
  }
  const expected = [...input.zoneUuids].sort();
  const identity = (source: string): ContentIdentity => Object.freeze({ algorithm: "sha256",
    digest: createHash("sha256").update(source, "utf8").digest("hex"), size: Buffer.byteLength(source, "utf8") });
  interface ZoneCapture { readonly polygonCount: number; readonly pointCount: number; readonly cacheTokens: string; readonly filledState: "omitted" | "no" | "yes" }
  interface Capture { readonly identity: ContentIdentity; readonly withoutCaches: string; readonly zones: ReadonlyMap<string, ZoneCapture> }
  const capture = (source: string, phase: "before" | "after"): Capture => {
    // Validate physical whitespace and scalar strings before any cache spans can be excluded.
    freshBoardComparisonText(source);
    const rawTokens: SourceSpan[] = [];
    const root = parseDocument(source, "kicad_pcb", rawTokens);
    const directZones = children(root, "zone");
    if (directZones.length !== expected.length) throw new FreshKicadParseError("Direct zone inventory differs from the complete host refill selection.");
    const zoneSet = new Set(directZones);
    const identitySet = new Set<string>();
    const pending = root.children.map(node => ({ node, parent: root }));
    while (pending.length > 0) {
      const { node, parent } = pending.pop()!;
      if (node.name === "zone" && parent !== root) throw new FreshKicadParseError("Nested zones cannot be admitted by refill preservation.");
      if (node.name === "fill_segments" || (node.name.startsWith("filled_") && node.name !== "filled_polygon")) {
        throw new FreshKicadParseError("Unknown or legacy fill-cache forms are outside refill preservation.");
      }
      if (node.name === "filled_polygon" && !zoneSet.has(parent)) {
        throw new FreshKicadParseError("Only direct selected board-zone filled_polygon caches may change.");
      }
      if (node.name === "uuid" || node.name === "tstamp") {
        const value = node.values[0];
        if (node.values.length !== 1 || node.children.length !== 0 || value === undefined
            || !uuidPattern.test(value.value) || identitySet.has(value.value)) {
          throw new FreshKicadParseError("Source UUID inventory is malformed, noncanonical, or duplicated.");
        }
        identitySet.add(value.value);
      }
      for (const child of node.children) pending.push({ node: child, parent: node });
    }
    const byUuid = new Map<string, Node>();
    for (const zone of directZones) {
      const fields = zone.children.filter(child => child.name === "uuid" || child.name === "tstamp");
      const uuid = itemIdentity(zone, "Refill zone");
      if (uuid === null || fields.length !== 1 || !fields[0]!.values[0]!.quoted || !expected.includes(uuid) || byUuid.has(uuid)) {
        throw new FreshKicadParseError("Zone identity is missing, ambiguous, or outside the exact refill selection.");
      }
      byUuid.set(uuid, zone);
    }
    if (byUuid.size !== expected.length) throw new FreshKicadParseError("Selected refill zone inventory is incomplete.");
    const geometry = parseFreshPcbReferenceGeometry(source);
    const captures = new Map<string, ZoneCapture>();
    const excluded: SourceSpan[] = [];
    let rawTokenCursor = 0;
    // Process in source order so cache token extraction remains linear and bounded.
    for (const node of directZones) {
      const uuid = itemIdentity(node, "Refill zone")!;
      const zone = geometry.zones.find(candidate => candidate.uuid === uuid);
      const fillSettings = children(node, "fill");
      const fill = fillSettings[0];
      const mode = fill === undefined ? [] : children(fill, "mode");
      if (zone === undefined || zone.status !== "supported" || zone.kind !== "copper"
          || zone.layers.length !== 1 || !["F.Cu", "B.Cu"].includes(zone.layers[0]!) || zone.outlinePolygons.length === 0
          || fillSettings.length !== 1 || fill === undefined || fill.values.length > 1
          || fill.values.some(value => value.quoted || !["yes", "no"].includes(value.value))
          || (fill.values.length === 1 && fill.children.some(child => child.start < fill.values[0]!.end))
          || mode.length > 1 || (mode.length === 1 && (mode[0]!.children.length !== 0 || mode[0]!.values.length !== 1
            || mode[0]!.values[0]!.quoted || mode[0]!.values[0]!.value !== "0"))) {
        throw new FreshKicadParseError("Refill preservation requires a supported native solid single-layer copper zone with its complete outline/settings.");
      }
      const filledState = fill.values.length === 0 ? "omitted" : fill.values[0]!.value as "yes" | "no";
      if (phase === "after" && filledState !== "yes") {
        throw new FreshKicadParseError("Every after-refill zone must carry an explicit filled-state yes; an unfilled/transient state is not preserved refill completion.");
      }
      if (fill.values.length === 1) excluded.push(fill.values[0]!);
      const zoneLayers = node.children.filter(child => child.name === "layer" || child.name === "layers");
      if (zoneLayers.length !== 1 || zoneLayers[0]!.values.some(value => !value.quoted)) {
        throw new FreshKicadParseError("Refill zone layer selectors must be exact quoted names.");
      }
      const polygons = children(node, "filled_polygon");
      const cacheFingerprints: string[] = [];
      const distinctCaches = new Set<string>();
      let pointCount = 0;
      for (const [index, polygon] of polygons.entries()) {
        const observed = zone.filledPolygons[index];
        const layers = children(polygon, "layer");
        if (observed?.status !== "supported" || observed.contourGroup.length !== 1 || layers.length !== 1
            || layers[0]!.values.length !== 1 || !layers[0]!.values[0]!.quoted) {
          throw new FreshKicadParseError("Refill filled_polygon cache has malformed, repeated, nested or unknown fields.");
        }
        while (rawTokenCursor < rawTokens.length && rawTokens[rawTokenCursor]!.start < polygon.start) rawTokenCursor += 1;
        const hash = createHash("sha256");
        while (rawTokenCursor < rawTokens.length && rawTokens[rawTokenCursor]!.end <= polygon.end) {
          const span = rawTokens[rawTokenCursor++]!;
          const token = source.slice(span.start, span.end);
          hash.update(`${Buffer.byteLength(token, "utf8")}:`).update(token, "utf8");
        }
        const fingerprint = hash.digest("hex");
        if (distinctCaches.has(fingerprint)) throw new FreshKicadParseError("Duplicate filled_polygon cache forms are ambiguous.");
        distinctCaches.add(fingerprint);
        cacheFingerprints.push(fingerprint);
        pointCount += observed.contourGroup[0]!.pointsNm!.length;
        excluded.push(polygon);
      }
      captures.set(uuid, { polygonCount: polygons.length, pointCount, cacheTokens: cacheFingerprints.join(":"), filledState });
    }
    const parts: string[] = [];
    let retainedStart = 0;
    for (const cache of excluded.sort((a, b) => a.start - b.start)) {
      if (cache.start < retainedStart || cache.end <= cache.start) throw new FreshKicadParseError("Refill comparison exclusions overlap or have invalid source spans.");
      parts.push(source.slice(retainedStart, cache.start), " ");
      retainedStart = cache.end;
    }
    parts.push(source.slice(retainedStart));
    return { identity: identity(source), withoutCaches: parts.join(""), zones: captures };
  };
  const before = capture(input.beforePcbSource, "before"), after = capture(input.afterPcbSource, "after");
  const zones = expected.map(uuid => {
    const a = before.zones.get(uuid)!, b = after.zones.get(uuid)!;
    const filledStateTransition = a.filledState === "yes" ? "yes-to-yes" : a.filledState === "no" ? "no-to-yes" : "omitted-to-yes";
    return Object.freeze({ uuid, beforeFilledState: a.filledState, afterFilledState: "yes" as const, filledStateTransition,
      beforeFilledPolygonCount: a.polygonCount, afterFilledPolygonCount: b.polygonCount,
      beforePointCount: a.pointCount, afterPointCount: b.pointCount, cacheChanged: a.cacheTokens !== b.cacheTokens });
  });
  return Object.freeze({ schemaVersion: "evleda.fresh-plane-refill-preservation.v1",
    equal: freshBoardSerializationsEqual(before.withoutCaches, after.withoutCaches),
    beforeIdentity: before.identity, afterIdentity: after.identity, zoneUuids: Object.freeze(expected), zones: Object.freeze(zones),
    changedZoneCount: zones.filter(zone => zone.cacheChanged || zone.filledStateTransition !== "yes-to-yes").length,
    changedFilledStateZoneCount: zones.filter(zone => zone.filledStateTransition !== "yes-to-yes").length,
    beforeFilledPolygonCount: zones.reduce((sum, zone) => sum + zone.beforeFilledPolygonCount, 0),
    afterFilledPolygonCount: zones.reduce((sum, zone) => sum + zone.afterFilledPolygonCount, 0),
    fillCacheFreshness: "unverified", dcConnectivity: "not_evaluated", acceptanceEvaluated: false });
}

/**
 * Exact direct-route spans for a later narrowly scoped replacement comparison.
 * Only the characterized core straight-track / through-via forms are admitted.
 * Optional modifiers are rejected rather than lost when an entire selected span
 * is replaced. No source is normalized or returned for persistence.
 */
export function parseFreshPcbRouteSourceSpans(source: string): readonly Readonly<{ kind: "track" | "via"; id: string; start: number; end: number }>[] {
  freshBoardComparisonText(source);
  const root = parseDocument(source, "kicad_pcb");
  const resolveNet = freshPcbNetResolver(root);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const ids = new Set<string>();
  const pending = root.children.map(node => ({ node, parent: root }));
  while (pending.length > 0) {
    const { node, parent } = pending.pop()!;
    if (["segment", "via", "arc"].includes(node.name) && parent !== root) throw new FreshKicadParseError("Nested route forms have no supported direct-board replacement span.");
    if (node.name === "uuid" || node.name === "tstamp") {
      if (node.children.length !== 0 || node.values.length !== 1 || !uuidPattern.test(node.values[0]!.value) || ids.has(node.values[0]!.value)) throw new FreshKicadParseError("Route span source contains malformed or duplicate object identities.");
      ids.add(node.values[0]!.value);
    }
    node.children.forEach(child => pending.push({ node: child, parent: node }));
  }
  const field = (node: Node, name: string): Node => {
    const matches = children(node, name);
    if (matches.length !== 1) throw new FreshKicadParseError(`Route span requires one ${name} field.`);
    return matches[0]!;
  };
  const nm = (node: Node): number => {
    const value = freshReferenceNm(node.values[0]);
    if (node.children.length !== 0 || node.values.length !== 1 || value === null || value <= 0) throw new FreshKicadParseError("Route dimension must be a positive exact integer-nanometre quantity.");
    return value;
  };
  const point = (node: Node): readonly [number, number] => {
    const x = freshReferenceNm(node.values[0]), y = freshReferenceNm(node.values[1]);
    if (node.children.length !== 0 || node.values.length !== 2 || x === null || y === null) throw new FreshKicadParseError("Route point is not exactly representable in integer nanometres.");
    return [x, y];
  };
  return Object.freeze(root.children.filter(node => node.name === "segment" || node.name === "via").map(node => {
    const allowed = node.name === "segment" ? ["start", "end", "width", "layer", "net", "uuid", "tstamp"] : ["at", "size", "drill", "layers", "net", "uuid", "tstamp"];
    if (node.values.length !== 0 || node.children.some(child => !allowed.includes(child.name)) || new Set(node.children.map(child => child.name)).size !== node.children.length) throw new FreshKicadParseError("Route contains uncharacterized modifiers, fields or duplicate children.");
    const id = itemIdentity(node, "Route span");
    if (id === null || !uuidPattern.test(id)) throw new FreshKicadParseError("Route span requires an exact canonical UUID.");
    resolveNet(field(node, "net"));
    if (node.name === "segment") {
      const a = point(field(node, "start")), b = point(field(node, "end")); nm(field(node, "width"));
      const layer = field(node, "layer");
      if (a[0] === b[0] && a[1] === b[1] || layer.children.length !== 0 || layer.values.length !== 1 || !layer.values[0]!.quoted || !["F.Cu", "B.Cu"].includes(layer.values[0]!.value)) throw new FreshKicadParseError("Unsupported straight-track span geometry or layer.");
    } else {
      point(field(node, "at")); const size = nm(field(node, "size")), drill = nm(field(node, "drill"));
      const layers = field(node, "layers");
      if (drill >= size || layers.children.length !== 0 || layers.values.length !== 2 || layers.values.some(value => !value.quoted)
          || layers.values[0]!.value !== "F.Cu" || layers.values[1]!.value !== "B.Cu") throw new FreshKicadParseError("Only an exact F.Cu-to-B.Cu through-via span is characterized.");
    }
    return Object.freeze({ kind: node.name === "segment" ? "track" as const : "via" as const, id, start: node.start, end: node.end });
  }));
}

/** Complete direct-zone spans only; callers must separately validate the intended mutation spec. */
export function parseFreshPcbDirectZoneSourceSpans(source: string): readonly Readonly<{ uuid: string; start: number; end: number }>[] {
  freshBoardComparisonText(source);
  const root = parseDocument(source, "kicad_pcb");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const identifiers = new Set<string>();
  const zones = children(root, "zone");
  if (zones.length > 32) throw new FreshKicadParseError("Plane mutation supports at most 32 complete direct board zones.");
  const pending = root.children.map(node => ({ node, parent: root }));
  while (pending.length > 0) {
    const { node, parent } = pending.pop()!;
    if (node.name === "zone" && parent !== root) throw new FreshKicadParseError("Nested zones cannot be excluded by a direct-zone mutation.");
    if (node.name === "uuid" || node.name === "tstamp") {
      if (node.children.length !== 0 || node.values.length !== 1 || !uuidPattern.test(node.values[0]!.value) || identifiers.has(node.values[0]!.value)) throw new FreshKicadParseError("Plane mutation source contains malformed or duplicate object identities.");
      identifiers.add(node.values[0]!.value);
    }
    node.children.forEach(child => pending.push({ node: child, parent: node }));
  }
  return Object.freeze(zones.map(zone => {
    const uuid = itemIdentity(zone, "Plane mutation zone");
    if (uuid === null || !uuidPattern.test(uuid)) throw new FreshKicadParseError("Plane mutation requires each direct zone's canonical UUID.");
    return Object.freeze({ uuid, start: zone.start, end: zone.end });
  }));
}

/**
 * Comparison-only one-zone exclusion with exact inventory conservation. It does
 * not validate the excluded target settings; the caller must do that separately.
 * Other zones remain in the complete source comparison, except their validated
 * derived fill state/cache during an explicitly selected post-refill comparison.
 */
export function compareFreshPlaneMutationRemainder(input: {
  readonly beforePcbSource: string; readonly afterPcbSource: string;
  readonly beforeTargetUuid: string | null; readonly afterTargetUuid: string;
  readonly phase: "mutation" | "refilled";
}) {
  const before = parseFreshPcbDirectZoneSourceSpans(input.beforePcbSource), after = parseFreshPcbDirectZoneSourceSpans(input.afterPcbSource);
  const oldTarget = input.beforeTargetUuid === null ? null : before.find(zone => zone.uuid === input.beforeTargetUuid);
  const newTarget = after.find(zone => zone.uuid === input.afterTargetUuid);
  if (newTarget === undefined || input.beforeTargetUuid !== null && (oldTarget === undefined || input.beforeTargetUuid !== input.afterTargetUuid)
      || input.beforeTargetUuid === null && before.some(zone => zone.uuid === input.afterTargetUuid)) throw new FreshKicadParseError("Create/update target UUID inventory is inconsistent.");
  const unchangedIds = before.filter(zone => zone !== oldTarget).map(zone => zone.uuid).sort();
  const remainingAfter = after.filter(zone => zone !== newTarget).map(zone => zone.uuid).sort();
  if (JSON.stringify(unchangedIds) !== JSON.stringify(remainingAfter)) throw new FreshKicadParseError("A non-target zone was added, removed, or replaced.");
  const remove = (source: string, span: SourceSpan | null | undefined) => span == null ? source : `${source.slice(0, span.start)} ${source.slice(span.end)}`;
  const beforeRemainder = remove(input.beforePcbSource, oldTarget), afterRemainder = remove(input.afterPcbSource, newTarget);
  const refill = input.phase === "refilled" && unchangedIds.length > 0
    ? compareFreshPlaneRefillPreservation({ beforePcbSource: beforeRemainder, afterPcbSource: afterRemainder, zoneUuids: unchangedIds }) : null;
  return Object.freeze({ equal: refill?.equal ?? freshBoardSerializationsEqual(beforeRemainder, afterRemainder),
    extraZoneUuids: Object.freeze(unchangedIds), nonTargetRefillChanges: refill?.zones ?? Object.freeze([]),
    targetSettingsEvaluated: false as const, fillCacheFreshness: "unverified" as const });
}

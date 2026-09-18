import path from "node:path";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";
import type { KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { parseFreshPcbSourceDocument, parseFreshSchematicSourceDocument, parseFreshSchematicTerminalGeometrySource,
  type FreshKicadSourceNode as Node } from "./fresh-kicad-parser.js";

const MAX_SCHEMATIC_BYTES = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const requireValue = (value: unknown, message: string): void => { if (!value) throw new Error(`Unwired schematic seed: ${message}`); };
const named = (node: Node, name: string) => node.children.filter(child => child.name === name);
const field = (node: Node, name: string, optional = false): Node | undefined => {
  const values = named(node, name);
  requireValue(values.length === 1 || optional && values.length === 0, `missing or duplicate ${node.name}/${name}`);
  return values[0];
};
const scalar = (node: Node, name: string, optional = false): string | undefined => {
  const found = field(node, name, optional); if (found === undefined) return undefined;
  requireValue(found.values.length === 1 && found.children.length === 0, `malformed ${node.name}/${name}`);
  return found.values[0]!.value;
};
const tokens = (node: Node, rootName?: string): unknown => ({ name: node.name,
  values: node.values.map((atom, index) => ({ quoted: atom.quoted, value: index === 0 && rootName !== undefined ? rootName : atom.value })),
  children: node.children.map(child => tokens(child)) });

/** Pure strict inventory check; filesystem and close/profile provenance are separate host obligations. */
export function validateUnwiredPlaneSchematicSeed(source: string, name: string, bundle: PcbPlaneCompilationBundle,
  librarySources: ReadonlyMap<string, Readonly<{ source: string; identity: ContentIdentity }>>): readonly string[] {
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(bundle), "a genuine V2 bundle is required");
  requireValue(source.isWellFormed() && Buffer.byteLength(source) <= MAX_SCHEMATIC_BYTES, "schematic exceeds its supported source bound");
  const root = parseFreshSchematicSourceDocument(source);
  requireValue(root.values.length === 0, "root has unexpected scalar values");
  const allowedRoot = new Set(["version", "generator", "generator_version", "uuid", "paper", "title_block", "lib_symbols", "symbol", "sheet_instances", "embedded_fonts"]);
  requireValue(root.children.every(node => allowedRoot.has(node.name)), "connected, hierarchical, unknown or unsupported root forms are present");
  for (const key of allowedRoot) if (key !== "symbol") field(root, key, ["generator_version", "title_block", "embedded_fonts"].includes(key));
  requireValue(/^\d{8}$/u.test(scalar(root, "version")!) && scalar(root, "paper") === "A4", "unsupported root version or page");
  requireValue(field(root, "version")!.values[0]!.quoted === false && field(root, "paper")!.values[0]!.quoted
    && typeof scalar(root, "generator") === "string" && field(root, "generator")!.values[0]!.quoted, "malformed root metadata");
  if (field(root, "generator_version", true) !== undefined) requireValue(scalar(root, "generator_version")!.length <= 128
    && field(root, "generator_version")!.values[0]!.quoted, "malformed generator version");
  const rootUuid = scalar(root, "uuid")!; requireValue(UUID.test(rootUuid), "root UUID is invalid");
  requireValue(scalar(root, "embedded_fonts", true) === undefined || scalar(root, "embedded_fonts", true) === "no"
    && field(root, "embedded_fonts")!.values[0]!.quoted === false, "embedded fonts are unsupported");
  const title = field(root, "title_block", true);
  if (title !== undefined) requireValue(title.values.length === 0 && title.children.length === 1 && scalar(title, "title") === name
    && field(title, "title")!.values[0]!.quoted, "title does not match the project stem");
  const sheets = field(root, "sheet_instances")!, sheet = field(sheets, "path")!;
  requireValue(sheets.values.length === 0 && sheets.children.length === 1 && sheet.values.length === 1
    && sheet.values[0]!.quoted && sheet.values[0]!.value === "/" && sheet.children.length === 1 && scalar(sheet, "page") === "1"
    && field(sheet, "page")!.values[0]!.quoted, "sheet instance inventory is not the single root sheet");
  const uuids = new Set<string>();
  const inspectIds = (node: Node) => {
    if (node.name === "uuid") { requireValue(node.values.length === 1 && node.children.length === 0 && node.values[0]!.quoted
      && UUID.test(node.values[0]!.value) && !uuids.has(node.values[0]!.value), "missing, repeated or malformed UUID"); uuids.add(node.values[0]!.value); }
    node.children.forEach(inspectIds);
  };
  inspectIds(root);
  const library = field(root, "lib_symbols")!;
  requireValue(library.values.length === 0 && library.children.every(child => child.name === "symbol"), "unknown embedded library forms");
  const placed = parseFreshSchematicTerminalGeometrySource(source, contentIdentity(source));
  const references = new Set<string>(), requiredLibraries = new Set<string>();
  const instanceFields = new Set(["lib_id", "at", "unit", "body_style", "convert", "exclude_from_sim", "in_bom", "on_board", "dnp", "uuid", "property", "pin", "instances", "fields_autoplaced"]);
  const numeric = (node: Node, count: number, positive = false): void => {
    requireValue(node.children.length === 0 && node.values.length === count && node.values.every(atom => !atom.quoted
      && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(atom.value) && Number.isFinite(Number(atom.value))
      && Math.abs(Number(atom.value)) <= 2000 && (!positive || Number(atom.value) > 0)), `malformed presentation ${node.name}`);
  };
  const flag = (node: Node): void => requireValue(node.children.length === 0 && (node.values.length === 0
    || node.values.length === 1 && !node.values[0]!.quoted && ["yes", "no"].includes(node.values[0]!.value)), `malformed ${node.name} flag`);
  const presentation = (prop: Node): void => {
    requireValue(prop.children.every(child => ["at", "effects"].includes(child.name)), "unknown instance property content");
    const at = field(prop, "at")!, effects = field(prop, "effects")!;
    numeric(at, 3); requireValue([0, 90, 180, 270].includes(Number(at.values[2]!.value)), "unsupported property angle");
    requireValue(effects.values.length === 0 && effects.children.every(child => ["font", "justify", "hide"].includes(child.name)), "unknown effects content");
    const font = field(effects, "font")!;
    requireValue(font.values.length === 0 && font.children.every(child => ["size", "thickness", "bold", "italic"].includes(child.name)), "unknown font content");
    numeric(field(font, "size")!, 2, true);
    const thickness = field(font, "thickness", true); if (thickness !== undefined) numeric(thickness, 1, true);
    for (const key of ["bold", "italic"]) { const value = field(font, key, true); if (value !== undefined) flag(value); }
    const hide = field(effects, "hide", true); if (hide !== undefined) flag(hide);
    const justify = field(effects, "justify", true);
    if (justify !== undefined) requireValue(justify.children.length === 0 && justify.values.length <= 2
      && justify.values.every(atom => !atom.quoted && ["left", "right", "top", "bottom"].includes(atom.value))
      && new Set(justify.values.map(atom => atom.value)).size === justify.values.length
      && !(justify.values.some(atom => atom.value === "left") && justify.values.some(atom => atom.value === "right"))
      && !(justify.values.some(atom => atom.value === "top") && justify.values.some(atom => atom.value === "bottom")), "unsupported justification");
  };
  for (const component of placed) {
    const expected = bundle.contract.components.find(item => item.reference === component.reference);
    requireValue(expected !== undefined && expected.symbolLibId === component.symbolLibId && !component.symbolLibId.startsWith("power:")
      && component.unit === 1 && component.bodyStyle === 1,
      "extra component or changed library/unit/body selection");
    requireValue(!references.has(component.reference) && component.symbolUuid !== null, "duplicate or unidentified component");
    references.add(component.reference); requiredLibraries.add(component.symbolLibId);
    const instance = named(root, "symbol").find(node => scalar(node, "uuid") === component.symbolUuid)!;
    requireValue(instance.values.length === 0 && instance.children.every(child => instanceFields.has(child.name)), "unknown instance electrical or disposition forms");
    for (const key of instanceFields) if (!["property", "pin"].includes(key)) field(instance, key, true);
    requireValue(scalar(instance, "lib_id") === component.symbolLibId && field(instance, "lib_id")!.values[0]!.quoted, "instance library ID is not native quoted metadata");
    numeric(field(instance, "at")!, 3);
    for (const key of ["unit", "body_style", "convert"]) { const value = field(instance, key, true); if (value !== undefined) {
      numeric(value, 1); requireValue(value.values[0]!.value === "1", "unsupported instance unit/body selection");
    } }
    const autoplaced = field(instance, "fields_autoplaced", true); if (autoplaced !== undefined) flag(autoplaced);
    for (const pin of named(instance, "pin")) requireValue(pin.values.length === 1 && pin.values[0]!.quoted
      && expected!.pins.some(expectedPin => expectedPin.pin === pin.values[0]!.value)
      && pin.children.length === 1 && scalar(pin, "uuid") !== undefined, "unsupported instance pin metadata");
    requireValue(new Set(named(instance, "pin").map(pin => pin.values[0]!.value)).size === named(instance, "pin").length, "duplicate instance pin metadata");
    requireValue(scalar(instance, "in_bom") === "yes" && scalar(instance, "on_board") === "yes"
      && [undefined, "no"].includes(scalar(instance, "exclude_from_sim", true)) && [undefined, "no"].includes(scalar(instance, "dnp", true)), "unsupported component disposition");
    for (const key of ["in_bom", "on_board", "exclude_from_sim", "dnp"]) requireValue(field(instance, key, true)?.values[0]?.quoted !== true, "disposition must use native unquoted tokens");
    const props = named(instance, "property"), propertyNames = props.map(node => node.values[0]?.value);
    requireValue(new Set(propertyNames).size === props.length && propertyNames.every(key => ["Reference", "Value", "Footprint", "Datasheet", "Description"].includes(key ?? "")), "unknown or duplicate instance properties");
    for (const prop of props) { requireValue(prop.values.length === 2 && prop.values.every(atom => atom.quoted), "malformed instance property"); presentation(prop); }
    for (const [key, value] of [["Reference", component.reference], ["Value", expected!.value], ["Footprint", expected!.footprintLibId]]) {
      requireValue(props.find(prop => prop.values[0]!.value === key)?.values[1]?.value === value, `${component.reference} ${key} differs from the contract`);
    }
    requireValue(canonicalJson([...component.pins.map(pin => pin.number)].sort()) === canonicalJson(expected!.pins.map(pin => pin.pin).sort()), "complete selected pin inventory differs from the contract");
    const instances = field(instance, "instances")!, project = field(instances, "project")!, instancePath = field(project, "path")!;
    requireValue(instances.values.length === 0 && instances.children.length === 1 && project.values.length === 1 && project.values[0]!.quoted && project.values[0]!.value === name
      && project.children.length === 1 && instancePath.values.length === 1 && instancePath.values[0]!.quoted && instancePath.values[0]!.value === `/${rootUuid}`
      && instancePath.children.length === 2 && scalar(instancePath, "reference") === component.reference && field(instancePath, "reference")!.values[0]!.quoted
      && scalar(instancePath, "unit") === "1" && field(instancePath, "unit")!.values[0]!.quoted === false,
    "instance project/root/reference/unit binding differs");
  }
  requireValue(references.size > 0 && library.children.length === requiredLibraries.size
    && new Set(library.children.map(node => node.values[0]?.value)).size === library.children.length, "seed needs a nonempty subset and only its complete required definitions");
  for (const definition of library.children) {
    const id = definition.values[0]?.value;
    requireValue(id !== undefined && requiredLibraries.has(id), "extra embedded definition");
    const inspected = librarySources.get(id!);
    const pin = bundle.libraryBinding.sourceSelection?.records.find(record => record.kind === "symbol" && record.libraryId === id);
    requireValue(inspected !== undefined && pin !== undefined && canonicalJson(inspected.identity) === canonicalJson(pin.sourceIdentity)
      && canonicalJson(contentIdentity(inspected!.source)) === canonicalJson(pin!.sourceIdentity), "embedded definition lacks current approved source bytes");
    const document = parseFreshPcbSourceDocument(`(kicad_pcb ${inspected!.source})`).children;
    requireValue(document.length === 1 && document[0]!.name === "kicad_symbol_lib", "approved source is not one symbol library");
    const original = named(document[0]!, "symbol").filter(node => node.values[0]?.value === id!.slice(id!.indexOf(":") + 1));
    requireValue(original.length === 1 && canonicalJson(tokens(original[0]!, id)) === canonicalJson(tokens(definition, id)),
      `complete embedded definition ${id} differs from its exact approved source`);
    requireValue(named(definition, "power").length === 0, "power annotation definitions are unsupported in an unwired seed");
  }
  return Object.freeze([...references].sort());
}

export interface FreshPlaneSchematicSeed { readonly kind: "qualified-unwired-plane-schematic" }
interface SeedState { source: string; name: string; bundle: string; profile: string; assertCurrent: () => Promise<void>; target?: string }
const seeds = new WeakMap<object, SeedState>();
/** Host-only minting after close/source/library qualification under a held lease. */
export function issueFreshPlaneSchematicSeed(input: { source: string; name: string; bundle: PcbPlaneCompilationBundle; profile: KicadMcpPinnedFileInput;
  librarySources: ReadonlyMap<string, Readonly<{ source: string; identity: ContentIdentity }>>; assertCurrent: () => Promise<void> }): FreshPlaneSchematicSeed {
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(input.bundle), "target bundle is not authenticated");
  validateUnwiredPlaneSchematicSeed(input.source, input.name, input.bundle, input.librarySources);
  const capability: FreshPlaneSchematicSeed = Object.freeze({ kind: "qualified-unwired-plane-schematic" });
  seeds.set(capability, { source: input.source, name: input.name, bundle: canonicalJson(input.bundle.identity), profile: canonicalJson(input.profile), assertCurrent: input.assertCurrent });
  return capability;
}
export async function consumeFreshPlaneSchematicSeed(seed: FreshPlaneSchematicSeed, outputDir: string, name: string, bundle: PcbPlaneCompilationBundle): Promise<string> {
  const state = seeds.get(seed);
  requireValue(state !== undefined && state.target === undefined && state.name === name && state.bundle === canonicalJson(bundle.identity), "forged, reused or differently bound seed capability");
  state!.target = path.resolve(outputDir);
  await state!.assertCurrent();
  return state!.source;
}
export function assertFreshPlaneSchematicSeedBaseline(seed: FreshPlaneSchematicSeed, outputDir: string, source: string): void {
  const state = seeds.get(seed);
  requireValue(state !== undefined && state.target === path.resolve(outputDir) && source === state.source, "initial seeded bytes differ from their one-invocation authority");
}
export function assertFreshPlaneSchematicSeedProfile(seed: FreshPlaneSchematicSeed, profile: KicadMcpPinnedFileInput): void {
  requireValue(seeds.get(seed)?.profile === canonicalJson(profile), "target native profile differs from the same-connection source profile");
}
export async function assertFreshPlaneSchematicSeedCurrent(seed: FreshPlaneSchematicSeed): Promise<void> {
  const state = seeds.get(seed); requireValue(state !== undefined, "seed capability is not host-issued");
  await state!.assertCurrent();
}

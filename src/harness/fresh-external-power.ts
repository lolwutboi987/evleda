import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { FreshConnectivityContract } from "./fresh-connectivity-contract.js";
import { parseFreshSchematicPowerFlagInstances, parseFreshSchematicPresentationSource, parseFreshSchematicSource } from "./fresh-kicad-parser.js";
import { transformFreshSchematicSourcePin } from "./fresh-schematic-terminal-groups.js";

export interface FreshExternalPowerPlacement { readonly reference: string; readonly x: number; readonly y: number; readonly rotation: 0 }
export interface FreshExternalPowerGroup { readonly name: string; readonly endpoints: readonly string[] }
const key = (endpoint: { reference: string; pin: string }) => `${endpoint.reference}:${endpoint.pin}`;
const same = (a: number, b: number) => Math.abs(a - b) < 0.000_001;

/** Verify the complete source inventory before granting any annotation exclusion. */
export function verifyFreshExternalPowerSource(contract: FreshConnectivityContract, source: string,
  options: Readonly<{ allowAbsent?: boolean; groups?: readonly FreshExternalPowerGroup[]; placements?: readonly FreshExternalPowerPlacement[] }> = {}) {
  const binding = contract.externalPowerBinding;
  const schematic = parseFreshSchematicSource(source), symbols = schematic.symbols;
  const physical = new Set(contract.components.map(component => component.reference));
  if (binding === undefined) {
    if (symbols.some(symbol => !physical.has(symbol.reference))) throw new Error("Unexpected schematic symbol is not a source-bound external power annotation.");
    return Object.freeze({ references: Object.freeze([] as string[]), physicalSymbols: symbols, groups: options.groups });
  }
  const references = binding.flags.map(flag => flag.reference);
  if (!symbols.some(symbol => references.includes(symbol.reference)) && options.allowAbsent === true) {
    if (symbols.some(symbol => !physical.has(symbol.reference)) || options.groups?.some(group => group.endpoints.some(endpoint => endpoint.startsWith("#")))) throw new Error("Pristine schematic contains an unverified auxiliary symbol or endpoint.");
    if (schematic.wires.length > 0 || schematic.labels.length > 0 || schematic.junctions.length > 0 || schematic.noConnects.length > 0) throw new Error("External power annotations may be absent only in a pristine schematic before connectivity authoring.");
    return Object.freeze({ references: Object.freeze([] as string[]), physicalSymbols: symbols, groups: options.groups });
  }
  const parsed = parseFreshSchematicPowerFlagInstances(source, contentIdentity(source), references);
  const sourceEndpoints = new Set(parsed.auxiliary.map(symbol => `${symbol.reference}:1`));
  if (options.groups?.some(group => group.endpoints.some(endpoint => endpoint.startsWith("#") && !sourceEndpoints.has(endpoint)))) throw new Error("Native connectivity contains an unverified auxiliary endpoint or flag pin.");
  if (parsed.placed.some(symbol => !physical.has(symbol.reference) && !references.includes(symbol.reference))) throw new Error("Unexpected schematic symbol is outside the complete physical/annotation inventory.");
  if (parsed.auxiliary.length !== references.length || canonicalJson(parsed.definitionSemanticIdentity) !== canonicalJson(binding.source.definitionSemanticIdentity)) throw new Error("External power annotation inventory or complete embedded definition differs from the bound stock source.");
  const presentation = parseFreshSchematicPresentationSource(source);
  for (const flag of binding.flags) {
    const actual = parsed.auxiliary.find(symbol => symbol.reference === flag.reference)!;
    const pin = actual.pins[0];
    if (actual.pins.length !== 1 || pin?.number !== "1" || pin.electricalType !== "power_out" || pin.lengthMm !== 0 || pin.at.xMm !== 0 || pin.at.yMm !== 0
      || actual.placement.rotationDeg !== 0 || [actual.placement.at.xMm, actual.placement.at.yMm].some(value => Math.abs(value / 1.27 - Math.round(value / 1.27)) > 1e-7)) throw new Error(`External power ${flag.reference} pin geometry or placement is unsupported.`);
    const expected = options.placements?.find(value => value.reference === flag.reference);
    if (options.placements !== undefined && (expected === undefined || !same(expected.x, actual.placement.at.xMm) || !same(expected.y, actual.placement.at.yMm) || expected.rotation !== actual.placement.rotationDeg)) throw new Error(`External power ${flag.reference} differs from its collision-checked placement.`);
    const anchor = parsed.placed.find(symbol => symbol.reference === flag.anchorEndpoint.reference);
    const anchorPin = anchor?.pins.find(pin => pin.number === flag.anchorEndpoint.pin);
    if (anchor === undefined || anchorPin === undefined) throw new Error(`External power ${flag.reference} has no exact physical anchor pin.`);
    const point = transformFreshSchematicSourcePin(anchorPin, anchor.placement).at;
    if (Math.abs(point.xMm - actual.placement.at.xMm) + Math.abs(point.yMm - actual.placement.at.yMm) > 76.2) throw new Error(`External power ${flag.reference} is outside its bounded connector attachment region.`);
    const fields = presentation.symbolFields.filter(field => field.reference === flag.reference);
    const reference = fields.find(field => field.kind === "Reference"), value = fields.find(field => field.kind === "Value");
    if (reference === undefined || !reference.hidden || value === undefined || value.hidden || value.text !== "PWR_FLAG"
      || value.at === null || !same(value.at.x, actual.placement.at.xMm) || !same(value.at.y, actual.placement.at.yMm - 5.08)
      || value.rotationDeg !== 0 || value.fontSizeMm?.x !== 1.27 || value.fontSizeMm?.y !== 1.27 || value.bold || value.italic || value.justify !== null && value.justify.length !== 0) throw new Error(`External power ${flag.reference} field layout differs from the supported native writer.`);
    if (actual.fields.some(field => !["Reference", "Value", "Footprint", "Datasheet"].includes(field.name)
      || field.name === "Footprint" && (!field.presentation.hidden || field.text !== "")
      || field.name === "Datasheet" && (!field.presentation.hidden || !["", "~"].includes(field.text)))) throw new Error(`External power ${flag.reference} has unqualified visible or extra fields.`);
  }
  let groups = options.groups;
  if (groups !== undefined) {
    for (const flag of binding.flags) {
      const endpoint = `${flag.reference}:1`, matches = groups.filter(group => group.endpoints.includes(endpoint));
      const expectedNet = contract.nets.find(net => net.name === flag.net);
      const expected = [...(expectedNet?.endpoints.map(key) ?? []), ...binding.flags.filter(other => other.net === flag.net).map(other => `${other.reference}:1`)].sort();
      if (matches.length !== 1 || matches[0]!.name !== flag.net || canonicalJson([...matches[0]!.endpoints].sort()) !== canonicalJson(expected)) throw new Error(`External power ${flag.reference}:1 is not on exactly its declared complete physical net ${flag.net}.`);
    }
    const endpoints = new Set(binding.flags.map(flag => `${flag.reference}:1`));
    groups = Object.freeze(groups.map(group => Object.freeze({ name: group.name, endpoints: Object.freeze(group.endpoints.filter(endpoint => !endpoints.has(endpoint))) })));
  }
  return Object.freeze({ references: Object.freeze(references), physicalSymbols: Object.freeze(symbols.filter(symbol => physical.has(symbol.reference))), groups });
}

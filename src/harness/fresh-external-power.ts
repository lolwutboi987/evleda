import { canonicalJson, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity } from "../domain/types.js";
import type { FreshConnectivityContract } from "./fresh-connectivity-contract.js";
import { parseFreshSchematicPowerFlagInstances, parseFreshSchematicPresentationSource, parseFreshSchematicSource, parseFreshSchematicTerminalGeometrySource } from "./fresh-kicad-parser.js";
import { transformFreshSchematicSourcePin } from "./fresh-schematic-terminal-groups.js";
import { pcbDerivedPowerPinGeometryIdentity, powerAnnotationBindingOf } from "./pcb-derived-power.js";

export interface FreshExternalPowerPlacement { readonly reference: string; readonly x: number; readonly y: number; readonly rotation: 0 }
/** Facts from the fully verified saved source, not fields reported by sch_get_symbols. */
export interface FreshExternalPowerSourcePlacement extends FreshExternalPowerPlacement {
  readonly library: string;
  readonly symbol: string;
  readonly value: string;
  readonly unit: number;
  readonly sourceIdentity: ContentIdentity;
}
export interface FreshExternalPowerGroup { readonly name: string; readonly endpoints: readonly string[] }
const key = (endpoint: { reference: string; pin: string }) => `${endpoint.reference}:${endpoint.pin}`;
const same = (a: number, b: number) => Math.abs(a - b) < 0.000_001;

/** Verify the complete source inventory before granting any annotation exclusion. */
export function verifyFreshExternalPowerSource(contract: FreshConnectivityContract, source: string,
  options: Readonly<{ allowAbsent?: boolean; groups?: readonly FreshExternalPowerGroup[]; placements?: readonly FreshExternalPowerPlacement[] }> = {}) {
  const binding = powerAnnotationBindingOf(contract);
  const schematic = parseFreshSchematicSource(source), symbols = schematic.symbols;
  const physical = new Set(contract.components.map(component => component.reference));
  if (binding === undefined) {
    if (symbols.some(symbol => !physical.has(symbol.reference))) throw new Error("Unexpected schematic symbol is not a source-bound external power annotation.");
    return Object.freeze({ references: Object.freeze([] as string[]), sourcePlacements: Object.freeze([] as FreshExternalPowerSourcePlacement[]), physicalSymbols: symbols, groups: options.groups });
  }
  const references = binding.flags.map(flag => flag.reference);
  const flagsAbsent = !symbols.some(symbol => references.includes(symbol.reference));
  const pristine = options.allowAbsent === true && flagsAbsent && schematic.wires.length === 0
    && schematic.labels.length === 0 && schematic.junctions.length === 0 && schematic.noConnects.length === 0;
  if (contract.derivedPowerBinding !== undefined) {
    // The path assertion is valid only for the complete selected saved driver and
    // passive pin definitions, even before any annotations have been authored.
    const placed = pristine && symbols.length === 0 ? [] : parseFreshSchematicTerminalGeometrySource(source, contentIdentity(source), references);
    if (!pristine && (symbols.filter(symbol => physical.has(symbol.reference)).length !== physical.size
      || contract.components.some(component => {
        const matches = symbols.filter(symbol => symbol.reference === component.reference), actual = matches[0];
        return matches.length !== 1 || actual === undefined || actual.libId !== component.symbolLibId
          || actual.value !== component.value || actual.footprint !== component.footprintLibId;
      }))) {
      throw new Error("Derived power saved physical component inventory, symbol IDs, values, or footprints differ from the complete contract.");
    }
    for (const bound of contract.derivedPowerBinding.symbols) {
      const matches = placed.filter(symbol => symbol.reference === bound.reference), actual = matches[0];
      // Fresh sessions author physical components incrementally. Missing path
      // symbols are permitted only before every connectivity primitive/flag.
      if (matches.length === 0 && pristine) continue;
      if (matches.length !== 1 || actual === undefined || actual.symbolLibId !== bound.libraryId || actual.unit !== 1 || actual.bodyStyle !== 1
        || actual.embeddedGeometry.representations.some(representation => representation.unit > 1 || representation.bodyStyle > 1)
        || canonicalJson(pcbDerivedPowerPinGeometryIdentity(actual.pins)) !== canonicalJson(bound.pinGeometryIdentity)) {
        throw new Error(`Derived power ${bound.reference} saved symbol identity or complete selected pin geometry differs from its source binding.`);
      }
    }
  }
  if (flagsAbsent && options.allowAbsent === true) {
    if (symbols.some(symbol => !physical.has(symbol.reference)) || options.groups?.some(group => group.endpoints.some(endpoint => endpoint.startsWith("#")))) throw new Error("Pristine schematic contains an unverified auxiliary symbol or endpoint.");
    if (schematic.wires.length > 0 || schematic.labels.length > 0 || schematic.junctions.length > 0 || schematic.noConnects.length > 0) throw new Error("External power annotations may be absent only in a pristine schematic before connectivity authoring.");
    return Object.freeze({ references: Object.freeze([] as string[]), sourcePlacements: Object.freeze([] as FreshExternalPowerSourcePlacement[]), physicalSymbols: symbols, groups: options.groups });
  }
  const parsed = parseFreshSchematicPowerFlagInstances(source, contentIdentity(source), references);
  const sourceEndpoints = new Set(parsed.auxiliary.map(symbol => `${symbol.reference}:1`));
  if (options.groups?.some(group => group.endpoints.some(endpoint => endpoint.startsWith("#") && !sourceEndpoints.has(endpoint)))) throw new Error("Native connectivity contains an unverified auxiliary endpoint or flag pin.");
  if (parsed.placed.some(symbol => !physical.has(symbol.reference) && !references.includes(symbol.reference))) throw new Error("Unexpected schematic symbol is outside the complete physical/annotation inventory.");
  if (parsed.auxiliary.length !== references.length || canonicalJson(parsed.definitionSemanticIdentity) !== canonicalJson(binding.source.definitionSemanticIdentity)) throw new Error("External power annotation inventory or complete embedded definition differs from the bound stock source.");
  const presentation = parseFreshSchematicPresentationSource(source);
  const sourcePlacements: FreshExternalPowerSourcePlacement[] = [];
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
    const [library, symbol] = actual.symbolLibId.split(":");
    sourcePlacements.push(Object.freeze({ reference: actual.reference, library: library!, symbol: symbol!, value: value.text,
      unit: actual.unit, x: actual.placement.at.xMm, y: actual.placement.at.yMm, rotation: actual.placement.rotationDeg,
      sourceIdentity: actual.sourceIdentity }));
  }
  let groups = options.groups;
  if (groups !== undefined) {
    const nativeGroups = groups;
    for (const netName of new Set(contract.derivedPowerBinding?.paths.flatMap(path => path.requiredNets) ?? [])) {
      const net = contract.nets.find(candidate => candidate.name === netName);
      if (net === undefined) throw new Error(`Derived power required net ${netName} is absent from physical connectivity.`);
      const expected = [...net.endpoints.map(key), ...binding.flags.filter(flag => flag.net === netName).map(flag => `${flag.reference}:1`)].sort();
      const matches = groups.filter(group => group.name === netName);
      if (matches.length !== 1 || canonicalJson([...matches[0]!.endpoints].sort()) !== canonicalJson(expected)
        || expected.some(endpoint => nativeGroups.filter(group => group.endpoints.includes(endpoint)).length !== 1)) {
        throw new Error(`Derived power required net ${netName} is not exactly its complete physical and annotation group.`);
      }
    }
    for (const flag of binding.flags) {
      const endpoint = `${flag.reference}:1`, matches = groups.filter(group => group.endpoints.includes(endpoint));
      const expectedNet = contract.nets.find(net => net.name === flag.net);
      const expected = [...(expectedNet?.endpoints.map(key) ?? []), ...binding.flags.filter(other => other.net === flag.net).map(other => `${other.reference}:1`)].sort();
      if (matches.length !== 1 || matches[0]!.name !== flag.net || canonicalJson([...matches[0]!.endpoints].sort()) !== canonicalJson(expected)) throw new Error(`External power ${flag.reference}:1 is not on exactly its declared complete physical net ${flag.net}.`);
    }
    const endpoints = new Set(binding.flags.map(flag => `${flag.reference}:1`));
    groups = Object.freeze(groups.map(group => Object.freeze({ name: group.name, endpoints: Object.freeze(group.endpoints.filter(endpoint => !endpoints.has(endpoint))) })));
  }
  return Object.freeze({ references: Object.freeze(references), sourcePlacements: Object.freeze(sourcePlacements), physicalSymbols: Object.freeze(symbols.filter(symbol => physical.has(symbol.reference))), groups });
}

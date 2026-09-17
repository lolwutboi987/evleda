import { z } from "zod";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity } from "../domain/types.js";
import { pcbDesignContractPayloadSchema } from "./pcb-design-contract.js";
import type { PcbLibraryBinding, PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";
import { assertPcbLibrarySourcesCurrent, isPcbLibraryRecordAuthorized } from "./pcb-library-source-binding.js";
import { selectFreshSymbolTerminalGeometryPins, type FreshSchematicTerminalPinGeometry } from "./fresh-kicad-parser.js";
import { createPcbExternalPowerBinding, inspectPcbPowerFlag, pcbPowerFlagSourceFromInspection, parsePcbExternalPowerBinding,
  type PcbExternalPowerBinding, type PcbExternalPowerFlagDescriptor } from "./pcb-external-power.js";

export const PCB_DERIVED_POWER_BINDING_SCHEMA_VERSION = "evleda.pcb-derived-power-binding.v1" as const;
export const PCB_DERIVED_POWER_PINS_SCHEMA_VERSION = "evleda.pcb-derived-power-pins.v1" as const;
export const PCB_DERIVED_POWER_EXECUTION_GUIDANCE = "Explicit derivedPowerSources record caller-reviewed source paths and operating assumptions for internal rails. Only a source-pinned power_out driver and the exact declared stock Device:L/Device:R passive path can support these schematic-only PWR_FLAG annotations. This is not electrical, current, thermal, feedback, or functional qualification. Preserve all physical components and nets, fully verify saved driver/passive pins and every upstream/path/return net, and require independent native ERC without suppressions. Internal rails are not external power inputs.";
export const PCB_EXTERNAL_DIODE_POWER_EXECUTION_GUIDANCE = "An explicit derivedPowerSources.externalPowerInput additionally permits one source-inspected stock Device:D_Schottky path from its exact bound externalPowerInputs connector supply, pin 2/A to pin 1/K, to an inspected power_in consumer with its inspected GND/PGND return on the same declared external ground. The external input ID, diodeForwardDropAssumption, operatingModes, source assertion and operatingAssumptions are caller declarations, not measurements or voltage/current/functional qualification. Verify the complete saved connector, diode, consumer, return and net bindings. The downstream rail remains internal; absent, reverse-biased, disabled, alternate-source and simultaneous-source modes require explicit operating assumptions, never inferred power availability.";
const closed = pcbDesignContractPayloadSchema.shape;
const endpoint = closed.nets.element.shape.endpoints.element;
const identifier = closed.netClasses.element.shape.id;
const reference = endpoint.shape.reference;
const pin = endpoint.shape.pin;
const text = z.string().trim().min(1).max(2048).refine(value => value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "Expected bounded scalar source text");
const source = z.object({ kind: z.literal("caller_assertion"), reference: text, description: text }).strict();
const step = z.object({ reference, entryPin: pin, exitPin: pin }).strict();
const externalPowerInput = z.object({ id: identifier, diodeForwardDropAssumption: text, operatingModes: text }).strict();
const declaration = z.object({ id: identifier, drivingEndpoint: endpoint, path: z.array(step).min(1).max(8),
  supplyEndpoint: endpoint, returnEndpoint: endpoint, source, operatingAssumptions: text, externalPowerInput: externalPowerInput.optional() }).strict();
export const pcbDerivedPowerSourcesSchema = z.array(declaration).min(1).max(8);
export const pcbDerivedPowerSourcesDraftSchema = z.array(declaration.extend({ drivingEndpoint: endpoint.nullable(),
  path: declaration.shape.path.nullable(), supplyEndpoint: endpoint.nullable(), returnEndpoint: endpoint.nullable(),
  source: source.extend({ reference: text.nullable(), description: text.nullable() }).strict().nullable(), operatingAssumptions: text.nullable(),
  externalPowerInput: externalPowerInput.extend({ id: identifier.nullable(), diodeForwardDropAssumption: text.nullable(), operatingModes: text.nullable() }).strict().optional(),
}).strict()).min(1).max(8);
export type PcbDerivedPowerSource = Readonly<z.infer<typeof declaration>>;
type Endpoint = Readonly<z.infer<typeof endpoint>>;
type DraftDeclaration = ReadonlyTree<z.infer<typeof pcbDerivedPowerSourcesDraftSchema.element>>;
export interface PcbDerivedPowerDocument {
  readonly derivedPowerSources?: readonly DraftDeclaration[] | null | undefined;
  readonly externalPowerInputs?: readonly Readonly<{ id: string; supplyEndpoint: Endpoint | null; returnEndpoint: Endpoint | null }>[] | null | undefined;
  readonly components: readonly Readonly<{ reference: string; symbolLibId: string | null;
    pins: readonly Readonly<{ pin: string; assignment: Readonly<{ kind: string; net?: string }> | null }>[] }>[];
  readonly nets: readonly Readonly<{ name: string; role: string | null; endpoints: readonly Endpoint[] }>[];
}
const key = (value: Endpoint) => `${value.reference}:${value.pin}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Structural continuity only; electrical pin authority is inspected by the host at binding. */
export function validatePcbDerivedPowerRelationships(document: PcbDerivedPowerDocument, context: z.RefinementCtx): void {
  if (document.derivedPowerSources == null) return;
  const ids = new Set<string>(), supplies = new Set<string>();
  const issue = (path: PropertyKey[], message: string) => context.addIssue({ code: "custom", path, message });
  for (const [index, entry] of document.derivedPowerSources.entries()) {
    const path: PropertyKey[] = ["derivedPowerSources", index];
    if (ids.has(entry.id)) issue([...path, "id"], "Derived power source IDs must be unique");
    ids.add(entry.id);
    const netOf = (point: Endpoint | null, field: PropertyKey[]) => {
      if (point === null) return undefined;
      const component = document.components.find(value => value.reference === point.reference);
      const assignment = component?.pins.find(value => value.pin === point.pin)?.assignment;
      if (assignment === undefined) { issue([...path, ...field], "Derived power endpoint must name an existing component pin"); return undefined; }
      if (assignment === null || assignment.kind === "unresolved") return undefined;
      if (assignment.kind !== "net") { issue([...path, ...field], "Derived power endpoint must have an exact net assignment, never a no-connect"); return undefined; }
      const net = document.nets.find(value => value.name === assignment.net);
      if (net === undefined || !net.endpoints.some(value => key(value) === key(point))) {
        issue([...path, ...field], "Derived power endpoint must belong to its exact assigned net"); return undefined;
      }
      return net;
    };
    const driver = netOf(entry.drivingEndpoint, ["drivingEndpoint"]);
    const supply = netOf(entry.supplyEndpoint, ["supplyEndpoint"]);
    const ground = netOf(entry.returnEndpoint, ["returnEndpoint"]);
    if (supply?.role != null && !["power", "power_input", "power_output"].includes(supply.role)) issue([...path, "supplyEndpoint"], "Derived supply requires a power net role");
    if (ground?.role != null && ground.role !== "ground") issue([...path, "returnEndpoint"], "Derived return requires the ground net");
    const external = entry.externalPowerInput === undefined ? undefined : document.externalPowerInputs?.find(value => value.id === entry.externalPowerInput!.id);
    if (entry.externalPowerInput !== undefined) {
      if (entry.externalPowerInput.id !== null && external === undefined) issue([...path, "externalPowerInput", "id"], "Derived external source must name an existing externalPowerInputs declaration");
      if (external?.supplyEndpoint != null && entry.drivingEndpoint !== null && !equal(external.supplyEndpoint, entry.drivingEndpoint)) issue([...path, "drivingEndpoint"], "Derived external driver must be the exact declared connector supply endpoint");
      const externalGround = external?.returnEndpoint == null ? undefined : netOf(external.returnEndpoint, ["externalPowerInput", "id"]);
      if (ground !== undefined && externalGround !== undefined && ground.name !== externalGround.name) issue([...path, "returnEndpoint"], "Derived consumer and external return must share the exact declared ground net");
      if (entry.supplyEndpoint !== null && entry.returnEndpoint !== null && (entry.supplyEndpoint.reference !== entry.returnEndpoint.reference || key(entry.supplyEndpoint) === key(entry.returnEndpoint))) issue([...path, "returnEndpoint"], "Derived external return must be a distinct ground pin of the consuming component");
      if (entry.path !== null && (entry.path.length !== 1 || entry.path[0]?.entryPin !== "2" || entry.path[0]?.exitPin !== "1")) issue([...path, "path"], "Derived external path requires one forward stock Schottky diode from pin 2/A to pin 1/K");
    } else if (entry.drivingEndpoint !== null && entry.returnEndpoint !== null
      && (entry.drivingEndpoint.reference !== entry.returnEndpoint.reference || key(entry.drivingEndpoint) === key(entry.returnEndpoint))) {
      issue([...path, "returnEndpoint"], "Derived return must be a distinct ground pin of the driving component");
    }
    if (supply !== undefined) {
      if (supplies.has(supply.name)) issue([...path, "supplyEndpoint"], "A derived supply net may have only one source declaration");
      supplies.add(supply.name);
    }
    if (driver !== undefined && (driver.name === supply?.name || driver.name === ground?.name)) issue(path, "Driver, downstream supply and ground nets must be distinct");
    if (supply !== undefined && supply.name === ground?.name) issue(path, "Derived supply and ground must be distinct");
    const seenComponents = new Set<string>(), seenNets = new Set(driver === undefined ? [] : [driver.name]);
    let previous = driver;
    for (const [stepIndex, item] of (entry.path ?? []).entries()) {
      const field = ["path", stepIndex];
      if (seenComponents.has(item.reference) || item.reference === entry.drivingEndpoint?.reference) issue([...path, ...field], "Derived passive path cannot repeat components or traverse the driver");
      seenComponents.add(item.reference);
      const component = document.components.find(value => value.reference === item.reference);
      if (component?.symbolLibId != null && !(entry.externalPowerInput === undefined ? ["Device:L", "Device:R"] : ["Device:D_Schottky"]).includes(component.symbolLibId)) issue([...path, ...field], entry.externalPowerInput === undefined ? "Derived passive path supports only exact stock Device:L and Device:R" : "Derived external path supports only exact stock Device:D_Schottky");
      if (item.entryPin === item.exitPin) issue([...path, ...field], "Derived path entry and exit pins must be distinct");
      const input = netOf({ reference: item.reference, pin: item.entryPin }, [...field, "entryPin"]);
      const output = netOf({ reference: item.reference, pin: item.exitPin }, [...field, "exitPin"]);
      if (previous !== undefined && input !== undefined && previous.name !== input.name) issue([...path, ...field, "entryPin"], "Derived passive path is not continuous from its explicit driver");
      if (input?.role === "ground" || output?.role === "ground") issue([...path, ...field], "Derived supply path cannot traverse ground");
      if (input !== undefined && output !== undefined && input.name === output.name) issue([...path, ...field], "Derived passive path must cross distinct nets");
      if (output !== undefined) {
        if (seenNets.has(output.name)) issue([...path, ...field], "Derived passive path cannot repeat nets or form a cycle");
        seenNets.add(output.name);
      }
      previous = output;
    }
    if (entry.path !== null && previous !== undefined && supply !== undefined && previous.name !== supply.name) issue([...path, "supplyEndpoint"], "Derived supply anchor is not on the final passive exit net");
  }
}

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const canonical = z.object({ algorithm: z.literal("sha256"), digest, schemaVersion: z.string().min(1).max(128), canonicalizationVersion: z.literal("evleda-c14n-json-v1") }).strict();
const content = z.object({ algorithm: z.literal("sha256"), digest, size: z.number().int().positive().max(24 * 1024 * 1024) }).strict();
const flagSource = z.object({ symbolLibId: z.literal("power:PWR_FLAG"), sourceIdentity: content, definitionIdentity: content,
  definitionSemanticIdentity: content, inspectionIdentity: canonical, policyIdentity: canonical }).strict();
const flag = z.object({ reference: z.string().regex(/^#FLG[0-9]{3}$/u), net: closed.nets.element.shape.name,
  anchorEndpoint: endpoint, symbolLibId: z.literal("power:PWR_FLAG") }).strict();
const symbol = z.object({ reference, libraryId: z.string().min(3).max(192), sourceIdentity: content, inspectionIdentity: canonical,
  definitionIdentity: content, pinGeometryIdentity: canonical }).strict();
const boundPath = declaration.extend({ netSequence: z.array(closed.nets.element.shape.name).min(2).max(9),
  requiredNets: z.array(closed.nets.element.shape.name).min(3).max(128) }).strict();
const bindingSchema = z.object({ schemaVersion: z.literal(PCB_DERIVED_POWER_BINDING_SCHEMA_VERSION), contractIdentity: canonical,
  libraryBindingIdentity: canonical, externalPowerBindingIdentity: canonical.optional(), source: flagSource,
  symbols: z.array(symbol).min(2).max(72), paths: z.array(boundPath).min(1).max(8), flags: z.array(flag).min(2).max(16), identity: canonical }).strict();
type ReadonlyTree<T> = T extends readonly (infer V)[] ? readonly ReadonlyTree<V>[] : T extends object ? { readonly [K in keyof T]: ReadonlyTree<T[K]> } : T;
export type PcbDerivedPowerBinding = ReadonlyTree<z.infer<typeof bindingSchema>>;
export type PcbPowerAnnotationBinding = PcbExternalPowerBinding | PcbDerivedPowerBinding;

/** Use only after the containing bundle/connectivity contract has validated both children. */
export function powerAnnotationBindingOf(value: { readonly externalPowerBinding?: PcbExternalPowerBinding | undefined; readonly derivedPowerBinding?: PcbDerivedPowerBinding | undefined }): PcbPowerAnnotationBinding | undefined {
  return value.derivedPowerBinding ?? value.externalPowerBinding;
}

/** Complete selected pin facts, independent of library-name qualification in saved definitions. */
export function pcbDerivedPowerPinGeometryIdentity(pins: readonly FreshSchematicTerminalPinGeometry[]): CanonicalIdentity {
  return canonicalIdentity([...pins].map(value => ({ ...value, at: { ...value.at } })).sort((a, b) => compare(a.number, b.number)), PCB_DERIVED_POWER_PINS_SCHEMA_VERSION);
}

/** Structural parsing does not grant source authority. Supply the third argument at a context boundary to check the external child. */
export function parsePcbDerivedPowerBinding(value: unknown, contractIdentity?: CanonicalIdentity, external?: PcbExternalPowerBinding): PcbDerivedPowerBinding {
  const parsed = bindingSchema.parse(hardenPortableValue(value, { maxBytes: 256 * 1024, maxDepth: 24, maxNodes: 16_384, maxArrayLength: 128, maxOwnKeys: 32, maxStringBytes: 8192 }));
  const { identity, ...payload } = parsed;
  if (!equal(identity, canonicalIdentity(payload, PCB_DERIVED_POWER_BINDING_SCHEMA_VERSION)) || contractIdentity !== undefined && !equal(parsed.contractIdentity, contractIdentity)) throw new Error("Derived power binding does not match its exact contract and payload");
  const sortedUnique = (values: readonly string[]) => values.every((value, i) => i === 0 || compare(values[i - 1]!, value) < 0);
  if (!sortedUnique(parsed.paths.map(value => value.id)) || !sortedUnique(parsed.symbols.map(value => value.reference))
    || parsed.symbols.some(value => value.pinGeometryIdentity.schemaVersion !== PCB_DERIVED_POWER_PINS_SCHEMA_VERSION)
    || parsed.paths.some(value => value.path.length + 1 !== value.netSequence.length || new Set(value.netSequence).size !== value.netSequence.length
      || new Set(value.path.map(step => step.reference)).size !== value.path.length || !sortedUnique(value.requiredNets)
      || value.netSequence.some(net => !value.requiredNets.includes(net)))) throw new Error("Derived power paths and symbol pins must be canonical and noncyclic");
  if (parsed.flags.some((value, i) => value.reference !== `#FLG${String(i + 1).padStart(3, "0")}`) || new Set(parsed.flags.map(value => value.net)).size !== parsed.flags.length) throw new Error("Derived power annotations must have complete canonical references and unique nets");
  for (const path of parsed.paths.filter(value => value.externalPowerInput !== undefined)) {
    if (parsed.externalPowerBindingIdentity === undefined || path.path.length !== 1 || path.path[0]!.entryPin !== "2" || path.path[0]!.exitPin !== "1"
      || path.supplyEndpoint.reference !== path.returnEndpoint.reference || key(path.supplyEndpoint) === key(path.returnEndpoint)
      || ![path.drivingEndpoint.reference, path.supplyEndpoint.reference, path.path[0]!.reference].every(reference => parsed.symbols.some(value => value.reference === reference))
      || parsed.symbols.find(value => value.reference === path.path[0]!.reference)?.libraryId !== "Device:D_Schottky") throw new Error("Derived external diode path lacks its exact external child, forward path or complete symbol binding");
  }
  if (arguments.length >= 3) {
    const current = external === undefined ? undefined : parsePcbExternalPowerBinding(external, parsed.contractIdentity);
    if (!equal(parsed.externalPowerBindingIdentity ?? null, current?.identity ?? null)) throw new Error("Derived power binding differs from its exact external power child");
    if (current !== undefined && (!equal(current.source, parsed.source) || !equal(parsed.flags.slice(0, current.flags.length), current.flags))) throw new Error("Combined power annotations must preserve the complete external source and descriptors");
    if (parsed.paths.some(path => path.externalPowerInput !== undefined && !current?.flags.some(flag => flag.net === path.netSequence[0] && equal(flag.anchorEndpoint, path.drivingEndpoint)))) throw new Error("Derived external driver is absent from its exact external child");
    const extra = parsed.flags.slice(current?.flags.length ?? 0);
    if (!sortedUnique(extra.map(value => value.net))) throw new Error("New derived power flags must be sorted by unique net");
  }
  return freeze(parsed);
}

function inspectSymbol(reference: string, library: PcbLibraryBinding, resolver: PcbReadOnlyLibraryResolver) {
  const record = library.symbols.find(value => value.reference === reference);
  if (record === undefined) throw new Error("Derived source symbol is absent from the physical library binding");
  const pinned = library.sourceSelection?.records.find(value => value.kind === "symbol" && value.libraryId === record.libraryId);
  const inspection = resolver.inspectSymbol?.(record.libraryId);
  const geometry = resolver.inspectSymbolTerminalGeometry?.(record.libraryId);
  if (pinned === undefined || inspection == null || geometry == null) throw new Error("Derived power requires host source-pinned full symbol and pin geometry inspection");
  const { identity, ...payload } = inspection;
  const { reference: _reference, ...boundRecord } = record;
  if (!equal(identity, canonicalIdentity(payload, inspection.schemaVersion)) || inspection.libraryId !== record.libraryId
    || !equal(inspection.sourceIdentity, pinned.sourceIdentity) || !equal(inspection.identity, pinned.inspectionIdentity)
    || !equal(inspection.resolverRecord, boundRecord) || !isPcbLibraryRecordAuthorized(resolver, "symbol", inspection.resolverRecord, library.sourceSelection)
    || geometry.libraryId !== record.libraryId || !equal(geometry.sourceIdentity, inspection.sourceIdentity)
    || geometry.representations.some(value => value.unit > 1 || value.bodyStyle > 1)) throw new Error("Derived power symbol inspection differs from its approved source and physical library binding");
  const pins = selectFreshSymbolTerminalGeometryPins(geometry, 1, 1);
  if (pins.length !== inspection.pins.length || pins.some(value => {
    const full = inspection.pins.find(item => item.number === value.number);
    return full === undefined || full.name !== (["", "~"].includes(value.name) ? null : value.name) || full.electricalType !== value.electricalType || !full.unitNumbers.includes(1);
  })) throw new Error("Derived power full symbol inspection disagrees with its complete selected pin geometry");
  return { record, pins, binding: { reference, libraryId: record.libraryId, sourceIdentity: inspection.sourceIdentity,
    inspectionIdentity: inspection.identity, definitionIdentity: geometry.definitionIdentity, pinGeometryIdentity: pcbDerivedPowerPinGeometryIdentity(pins) } };
}

export function assertPcbDerivedPowerBindingCurrent(binding: PcbDerivedPowerBinding, library: PcbLibraryBinding, resolver: PcbReadOnlyLibraryResolver) {
  const parsed = parsePcbDerivedPowerBinding(binding);
  if (!equal(parsed.libraryBindingIdentity, library.identity) || !equal(parsed.contractIdentity, library.contractIdentity)) throw new Error("Derived power binding has a different physical library or contract identity");
  assertPcbLibrarySourcesCurrent(library, resolver);
  const inspection = inspectPcbPowerFlag(resolver);
  if (!equal(parsed.source, pcbPowerFlagSourceFromInspection(inspection))) throw new Error("Derived power flag source or host policy changed");
  for (const expected of parsed.symbols) if (!equal(expected, inspectSymbol(expected.reference, library, resolver).binding)) throw new Error("Derived power source or passive pin inspection changed");
  assertPcbLibrarySourcesCurrent(library, resolver);
  return inspection;
}

export function createPcbDerivedPowerBinding(contract: PcbDerivedPowerDocument & { readonly identity: CanonicalIdentity }, library: PcbLibraryBinding,
  resolver: PcbReadOnlyLibraryResolver, external?: PcbExternalPowerBinding): PcbDerivedPowerBinding | undefined {
  if (contract.derivedPowerSources === undefined) return undefined;
  const declarations = pcbDerivedPowerSourcesSchema.parse(contract.derivedPowerSources);
  const problems: string[] = [];
  validatePcbDerivedPowerRelationships(contract, { addIssue: value => { problems.push(typeof value === "string" ? value : value.message ?? "Invalid derived path"); } } as z.RefinementCtx);
  if (problems.length > 0) throw new Error(problems.join("; "));
  if (!equal(library.contractIdentity, contract.identity)) throw new Error("Derived power library differs from the exact closed contract");
  assertPcbLibrarySourcesCurrent(library, resolver);
  const netOf = (point: Endpoint) => {
    const assignment = contract.components.find(value => value.reference === point.reference)?.pins.find(value => value.pin === point.pin)?.assignment;
    const net = contract.nets.find(value => value.name === assignment?.net);
    if (assignment?.kind !== "net" || net === undefined || net.endpoints.length < 2 || !net.endpoints.some(value => key(value) === key(point))) throw new Error("Derived source and every upstream pin require a connected exact physical net, never NC");
    return net;
  };
  const symbols = new Map<string, ReturnType<typeof inspectSymbol>>();
  const inspect = (reference: string) => {
    let value = symbols.get(reference);
    if (value === undefined) { value = inspectSymbol(reference, library, resolver); symbols.set(reference, value); }
    return value;
  };
  const previous = external === undefined ? undefined : parsePcbExternalPowerBinding(external, contract.identity);
  if (declarations.some(entry => entry.externalPowerInput !== undefined)
    && (previous === undefined || !equal(previous, createPcbExternalPowerBinding(contract, library, resolver)))) throw new Error("Derived external source requires the exact reconstructed external power binding");
  const anchors = new Map<string, Endpoint>();
  const paths = declarations.map(entry => {
    const driver = inspect(entry.drivingEndpoint.reference);
    const consumer = entry.externalPowerInput === undefined ? driver : inspect(entry.supplyEndpoint.reference);
    if (entry.externalPowerInput === undefined) {
      if (driver.pins.find(value => value.number === entry.drivingEndpoint.pin)?.electricalType !== "power_out") throw new Error("Derived driver must be the source-inspected power_out pin, never a name or caller pin-type assertion");
    } else {
      const input = contract.externalPowerInputs?.find(value => value.id === entry.externalPowerInput!.id);
      if (input?.supplyEndpoint == null || input.returnEndpoint == null || !equal(input.supplyEndpoint, entry.drivingEndpoint)) throw new Error("Derived external source requires its exact resolved external input endpoints");
      const externalReturn = inspect(input.returnEndpoint.reference);
      if ([driver, externalReturn].some(value => value.record.source !== "kicad-stock" || value.record.componentKind !== "connector")
        || !driver.pins.some(value => value.number === entry.drivingEndpoint.pin) || !externalReturn.pins.some(value => value.number === input.returnEndpoint!.pin)
        || netOf(input.returnEndpoint).name !== netOf(entry.returnEndpoint).name) throw new Error("Derived external source requires inspected stock connector pins and the exact common return net");
      if (consumer.pins.find(value => value.number === entry.supplyEndpoint.pin)?.electricalType !== "power_in") throw new Error("Derived external supply anchor must be a source-inspected power_in consumer pin");
    }
    const returnPin = consumer.pins.find(value => value.number === entry.returnEndpoint.pin);
    if (entry.returnEndpoint.reference !== consumer.record.reference || returnPin?.electricalType !== "power_in" || !/^(?:GND|PGND)(?:\/[A-Za-z0-9_]+)?$/u.test(returnPin.name)) throw new Error("Derived return must be the source-inspected power_in GND or PGND pin of the driver or explicit external consumer");
    const ground = netOf(entry.returnEndpoint), supply = netOf(entry.supplyEndpoint);
    if (ground.role !== "ground" || !["power", "power_input", "power_output"].includes(supply.role ?? "")) throw new Error("Derived supply/ground roles must be resolved");
    const netSequence = [netOf(entry.drivingEndpoint).name];
    for (const step of entry.path) {
      const passive = inspect(step.reference);
      const supported = entry.externalPowerInput === undefined ? ["Device:L", "Device:R"] : ["Device:D_Schottky"];
      if (passive.record.source !== "kicad-stock" || !supported.includes(passive.record.libraryId) || passive.pins.length !== 2
        || passive.pins.some(value => value.electricalType !== "passive") || !passive.pins.some(value => value.number === step.entryPin)
        || !passive.pins.some(value => value.number === step.exitPin)) throw new Error("Derived path requires actual two-pin source-inspected stock passive parts of its declared path kind");
      if (entry.externalPowerInput !== undefined && (entry.path.length !== 1 || step.entryPin !== "2" || step.exitPin !== "1"
        || passive.pins.find(value => value.number === "2")?.name !== "A" || passive.pins.find(value => value.number === "1")?.name !== "K")) throw new Error("Derived external path must use the exact stock Schottky two-pin A-to-K forward semantics");
      if (netOf({ reference: step.reference, pin: step.entryPin }).name !== netSequence.at(-1)) throw new Error("Derived path entry does not share the preceding driver or passive exit net");
      netSequence.push(netOf({ reference: step.reference, pin: step.exitPin }).name);
    }
    if (netSequence.at(-1) !== supply.name || new Set(netSequence).size !== netSequence.length) throw new Error("Derived path is cyclic or misses its downstream supply anchor");
    // The source IC may receive its own post-inductor rail on DVDD/FB; these are
    // connected supply checks, not passive-path cycle edges or functional proof.
    const requiredNets = [...new Set([...netSequence, ground.name, ...consumer.pins.filter(value => value.electricalType === "power_in")
      .map(value => netOf({ reference: consumer.record.reference, pin: value.number }).name)])].sort(compare);
    for (const [net, point] of [[supply.name, entry.supplyEndpoint], [ground.name, entry.returnEndpoint]] as const) {
      const previous = anchors.get(net);
      if (previous === undefined || compare(key(point), key(previous)) < 0) anchors.set(net, point);
    }
    return { ...entry, netSequence, requiredNets };
  }).sort((a, b) => compare(a.id, b.id));
  const inspection = inspectPcbPowerFlag(resolver);
  const flagSource = pcbPowerFlagSourceFromInspection(inspection);
  if (previous !== undefined && !equal(previous.source, flagSource)) throw new Error("External and derived flags require the same exact approved source");
  const flags: PcbExternalPowerFlagDescriptor[] = [...(previous?.flags ?? [])];
  for (const [net, anchorEndpoint] of [...anchors].sort(([a], [b]) => compare(a, b))) {
    if (flags.some(value => value.net === net)) continue;
    flags.push({ reference: `#FLG${String(flags.length + 1).padStart(3, "0")}`, net, anchorEndpoint, symbolLibId: "power:PWR_FLAG" });
  }
  if (flags.length > 16) throw new Error("Combined source-bound power annotations exceed the existing 16-flag limit");
  const payload = { schemaVersion: PCB_DERIVED_POWER_BINDING_SCHEMA_VERSION, contractIdentity: contract.identity, libraryBindingIdentity: library.identity,
    ...(previous === undefined ? {} : { externalPowerBindingIdentity: previous.identity }), source: flagSource,
    symbols: [...symbols.values()].map(value => value.binding).sort((a, b) => compare(a.reference, b.reference)), paths, flags };
  const binding = parsePcbDerivedPowerBinding({ ...payload, identity: canonicalIdentity(payload, PCB_DERIVED_POWER_BINDING_SCHEMA_VERSION) }, contract.identity, previous);
  assertPcbDerivedPowerBindingCurrent(binding, library, resolver);
  return binding;
}

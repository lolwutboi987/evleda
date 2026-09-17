import { z } from "zod";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { pcbDesignContractPayloadSchema } from "./pcb-design-contract.js";
import type { PcbLibraryBinding, PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";
import type { FreshSymbolTerminalGeometry } from "./fresh-kicad-parser.js";

export const PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION = "evleda.pcb-external-power-binding.v1" as const;
export const PCB_EXTERNAL_POWER_FLAG_INSPECTION_SCHEMA_VERSION = "evleda.pcb-external-power-flag-inspection.v1" as const;
export const PCB_EXTERNAL_POWER_FLAG_POLICY_SCHEMA_VERSION = "evleda.pcb-external-power-flag-policy.v1" as const;
export const PCB_EXTERNAL_POWER_FLAG_LIB_ID = "power:PWR_FLAG" as const;
export const PCB_EXTERNAL_POWER_EXECUTION_GUIDANCE = "Explicit externalPowerInputs are caller assertions of an off-board supply at the declared physical connector pins, not proof of voltage or an attached source. The host adds only the separately source-bound stock power:PWR_FLAG annotations to the declared supply and return nets. These schematic annotations have no footprint and do not add physical components, BOM items, netlist terminals, PCB pads, or routing endpoints. Preserve exact physical connectivity and require independent native ERC and source/annotation validation; never infer external power from a net name or waive a power-pin error.";
const closed = pcbDesignContractPayloadSchema.shape;
const endpoint = closed.nets.element.shape.endpoints.element;
const input = z.object({ id: closed.netClasses.element.shape.id, supplyEndpoint: endpoint, returnEndpoint: endpoint }).strict();
export const pcbExternalPowerInputsSchema = z.array(input).min(1).max(8);
export const pcbExternalPowerInputsDraftSchema = z.array(input.extend({
  supplyEndpoint: endpoint.nullable(), returnEndpoint: endpoint.nullable(),
}).strict()).min(1).max(8);
export type PcbExternalPowerInput = Readonly<z.infer<typeof input>>;
type Endpoint = Readonly<z.infer<typeof endpoint>>;
const key = (value: Endpoint) => `${value.reference}:${value.pin}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
interface PowerDocument {
  readonly externalPowerInputs?: readonly Readonly<{ id: string; supplyEndpoint: Endpoint | null; returnEndpoint: Endpoint | null }>[] | null | undefined;
  readonly components: readonly Readonly<{ reference: string; pins: readonly Readonly<{ pin: string; assignment: Readonly<{ kind: string; net?: string }> | null }>[] }>[];
  readonly nets: readonly Readonly<{ name: string; role: string | null; endpoints: readonly Endpoint[] }>[];
}
export function validatePcbExternalPowerRelationships(document: PowerDocument, context: z.RefinementCtx): void {
  if (document.externalPowerInputs == null) return;
  const ids = new Set<string>(), supplies = new Set<string>();
  const issue = (path: PropertyKey[], message: string) => context.addIssue({ code: "custom", path, message });
  for (const [index, entry] of document.externalPowerInputs.entries()) {
    const path: PropertyKey[] = ["externalPowerInputs", index];
    if (ids.has(entry.id)) issue([...path, "id"], "External power input IDs must be unique");
    ids.add(entry.id);
    const nets = ["supplyEndpoint", "returnEndpoint"].map(field => {
      const point = entry[field as "supplyEndpoint" | "returnEndpoint"];
      if (point === null) return null;
      const component = document.components.find(value => value.reference === point.reference);
      const pin = component?.pins.find(value => value.pin === point.pin);
      if (pin === undefined) { issue([...path, field], "External power endpoint must name an existing physical component pin"); return null; }
      if (pin.assignment === null) return null;
      if (pin.assignment.kind !== "net") { issue([...path, field], "External power endpoint must have an exact net assignment, never a no-connect"); return null; }
      const net = document.nets.find(value => value.name === pin.assignment!.net);
      if (net === undefined || !net.endpoints.some(value => key(value) === key(point))) {
        issue([...path, field], "External power endpoint must belong to its exact assigned net"); return null;
      }
      const expectedRole = field === "supplyEndpoint" ? "power_input" : "ground";
      if (net.role !== null && net.role !== expectedRole) issue([...path, field], `External power ${field} requires net role ${expectedRole}`);
      return net.name;
    });
    if (entry.supplyEndpoint !== null && entry.returnEndpoint !== null && key(entry.supplyEndpoint) === key(entry.returnEndpoint)) {
      issue(path, "External supply and return endpoints must be distinct");
    }
    if (nets[0] !== null && nets[0] === nets[1]) issue(path, "External supply and return nets must be distinct");
    if (nets[0] != null) {
      if (supplies.has(nets[0])) issue([...path, "supplyEndpoint"], "A supply net may have only one external power input declaration");
      supplies.add(nets[0]);
    }
  }
}

export interface PcbExternalPowerFlagInspection {
  readonly schemaVersion: typeof PCB_EXTERNAL_POWER_FLAG_INSPECTION_SCHEMA_VERSION;
  readonly symbolLibId: typeof PCB_EXTERNAL_POWER_FLAG_LIB_ID;
  readonly sourceIdentity: ContentIdentity;
  readonly definitionIdentity: ContentIdentity;
  readonly definitionSemanticIdentity: ContentIdentity;
  readonly policyIdentity: CanonicalIdentity;
  readonly powerScope: "global";
  readonly footprint: "";
  readonly inBom: true;
  readonly onBoard: true;
  readonly geometry: FreshSymbolTerminalGeometry;
  readonly identity: CanonicalIdentity;
}
export interface PcbExternalPowerFlagDescriptor {
  readonly reference: string;
  readonly net: string;
  readonly anchorEndpoint: Endpoint;
  readonly symbolLibId: typeof PCB_EXTERNAL_POWER_FLAG_LIB_ID;
}
export interface PcbExternalPowerBinding {
  readonly schemaVersion: typeof PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION;
  readonly contractIdentity: CanonicalIdentity;
  readonly source: Readonly<{
    symbolLibId: typeof PCB_EXTERNAL_POWER_FLAG_LIB_ID;
    sourceIdentity: ContentIdentity;
    definitionIdentity: ContentIdentity;
    definitionSemanticIdentity: ContentIdentity;
    inspectionIdentity: CanonicalIdentity;
    policyIdentity: CanonicalIdentity;
  }>;
  readonly flags: readonly PcbExternalPowerFlagDescriptor[];
  readonly identity: CanonicalIdentity;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const canonical = z.object({ algorithm: z.literal("sha256"), digest, schemaVersion: z.string().min(1).max(128), canonicalizationVersion: z.literal("evleda-c14n-json-v1") }).strict();
const content = z.object({ algorithm: z.literal("sha256"), digest, size: z.number().int().positive().max(24 * 1024 * 1024) }).strict();
const bindingSchema = z.object({ schemaVersion: z.literal(PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION), contractIdentity: canonical,
  source: z.object({ symbolLibId: z.literal(PCB_EXTERNAL_POWER_FLAG_LIB_ID), sourceIdentity: content, definitionIdentity: content,
    definitionSemanticIdentity: content, inspectionIdentity: canonical, policyIdentity: canonical }).strict(),
  flags: z.array(z.object({ reference: z.string().regex(/^#FLG[0-9]{3}$/u), net: closed.nets.element.shape.name,
    anchorEndpoint: endpoint, symbolLibId: z.literal(PCB_EXTERNAL_POWER_FLAG_LIB_ID) }).strict()).min(2).max(16), identity: canonical,
}).strict();
export function parsePcbExternalPowerBinding(value: unknown, contractIdentity?: CanonicalIdentity): PcbExternalPowerBinding {
  const parsed = bindingSchema.parse(hardenPortableValue(value, { maxBytes: 64 * 1024, maxDepth: 16, maxNodes: 4096, maxArrayLength: 32, maxOwnKeys: 32, maxStringBytes: 1024 }));
  const { identity, ...payload } = parsed;
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION))
      || (contractIdentity !== undefined && canonicalJson(parsed.contractIdentity) !== canonicalJson(contractIdentity))) throw new Error("External power binding identity does not match its exact contract and payload");
  if (parsed.flags.some((flag, index) => flag.reference !== `#FLG${String(index + 1).padStart(3, "0")}`
      || (index > 0 && compare(parsed.flags[index - 1]!.net, flag.net) >= 0))) throw new Error("External power flags must have canonical unique nets and references");
  return freeze(parsed);
}
export function pcbPowerFlagSourceFromInspection(inspection: PcbExternalPowerFlagInspection): PcbExternalPowerBinding["source"] {
  return { symbolLibId: inspection.symbolLibId, sourceIdentity: inspection.sourceIdentity, definitionIdentity: inspection.definitionIdentity,
    definitionSemanticIdentity: inspection.definitionSemanticIdentity, inspectionIdentity: inspection.identity, policyIdentity: inspection.policyIdentity };
}
export function inspectPcbPowerFlag(resolver: PcbReadOnlyLibraryResolver): PcbExternalPowerFlagInspection {
  const value = resolver.inspectExternalPowerFlag?.();
  if (value == null) throw new Error("External power inputs require host-approved exact stock power:PWR_FLAG inspection capability");
  const { identity, ...payload } = value;
  const pins = value.geometry.representations.flatMap(representation => representation.pins);
  if (value.schemaVersion !== PCB_EXTERNAL_POWER_FLAG_INSPECTION_SCHEMA_VERSION || value.symbolLibId !== PCB_EXTERNAL_POWER_FLAG_LIB_ID
      || value.powerScope !== "global" || value.footprint !== "" || value.inBom !== true || value.onBoard !== true
      || value.geometry.libraryId !== PCB_EXTERNAL_POWER_FLAG_LIB_ID || pins.length !== 1 || pins[0]!.number !== "1"
      || pins[0]!.electricalType !== "power_out" || pins[0]!.lengthMm !== 0
      || canonicalJson(value.geometry.sourceIdentity) !== canonicalJson(value.sourceIdentity)
      || canonicalJson(value.geometry.definitionIdentity) !== canonicalJson(value.definitionIdentity)
      || canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, PCB_EXTERNAL_POWER_FLAG_INSPECTION_SCHEMA_VERSION))) {
    throw new Error("External power flag source inspection is inconsistent or unsupported");
  }
  return value;
}
/** Current guarded source evidence, including complete geometry, for host authoring. */
export function assertPcbExternalPowerBindingCurrent(binding: PcbExternalPowerBinding, resolver: PcbReadOnlyLibraryResolver): PcbExternalPowerFlagInspection {
  const parsed = parsePcbExternalPowerBinding(binding);
  const current = inspectPcbPowerFlag(resolver);
  if (canonicalJson(parsed.source) !== canonicalJson(pcbPowerFlagSourceFromInspection(current))) throw new Error("External power flag source or host policy changed from the compilation binding");
  return current;
}
/** Physical libraries remain separate; annotations are derived only from closed declarations. */
export function createPcbExternalPowerBinding(contract: PowerDocument & { readonly identity: CanonicalIdentity }, library: PcbLibraryBinding,
  resolver: PcbReadOnlyLibraryResolver): PcbExternalPowerBinding | undefined {
  if (contract.externalPowerInputs === undefined) return undefined;
  if (contract.externalPowerInputs === null || contract.externalPowerInputs.length < 1) throw new Error("External power declarations must be resolved");
  const anchors = new Map<string, Endpoint>();
  for (const entry of contract.externalPowerInputs) for (const point of [entry.supplyEndpoint, entry.returnEndpoint]) {
    if (point === null) throw new Error("External power endpoints must be resolved");
    if (library.symbols.find(symbol => symbol.reference === point.reference)?.componentKind !== "connector") throw new Error("External power endpoints require exact stock physical connector symbols");
    const net = contract.nets.find(net => net.endpoints.some(endpoint => key(endpoint) === key(point)));
    if (net === undefined) throw new Error("External power endpoint is absent from physical connectivity");
    const old = anchors.get(net.name);
    if (old === undefined || compare(key(point), key(old)) < 0) anchors.set(net.name, point);
  }
  const inspection = inspectPcbPowerFlag(resolver);
  const flags = [...anchors.entries()].sort(([a], [b]) => compare(a, b)).map(([net, anchorEndpoint], index) => ({
    reference: `#FLG${String(index + 1).padStart(3, "0")}`, net, anchorEndpoint, symbolLibId: PCB_EXTERNAL_POWER_FLAG_LIB_ID,
  }));
  const payload = { schemaVersion: PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION, contractIdentity: contract.identity,
    source: pcbPowerFlagSourceFromInspection(inspection), flags };
  const binding = parsePcbExternalPowerBinding({ ...payload, identity: canonicalIdentity(payload, PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION) }, contract.identity);
  assertPcbExternalPowerBindingCurrent(binding, resolver);
  return binding;
}

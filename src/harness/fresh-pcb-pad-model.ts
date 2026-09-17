/** Pure physical-pad/logical-terminal semantics. Native authority belongs to the host observation adapter. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }
export interface PcbPadDefinitionNode {
  readonly name: string;
  readonly values: readonly { readonly value: string; readonly quoted: boolean }[];
  readonly children: readonly PcbPadDefinitionNode[];
}
/** Compare physical library fields, excluding only independently checked instance fields.
 * Root pad fields are unordered named properties; nested geometry ordering stays exact.
 * Actual layers are a set. Quoted values and unknown fields are otherwise preserved.
 */
export function physicalPadDefinitionKey(node: PcbPadDefinitionNode): string {
  requireCondition(node.name === 'pad', 'Physical definition must be a complete pad form');
  const instanceFields = new Set(['uuid', 'tstamp', 'net', 'at']);
  const atom = (entry: {readonly value:string;readonly quoted:boolean}): unknown => {
    if (entry.quoted) return ['string', entry.value];
    const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(entry.value) ? Number(entry.value) : NaN;
    return Number.isFinite(numeric) ? ['number', numeric === 0 ? 0 : numeric] : ['atom', entry.value];
  };
  const nested = (item: PcbPadDefinitionNode): unknown => [item.name,
    item.name === 'layers' ? [...item.values.map(atom)].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en')) : item.values.map(atom),
    item.children.map(nested)];
  const fields = node.children.filter(child => !instanceFields.has(child.name)).map(nested);
  fields.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
  return JSON.stringify([node.name,node.values.map(atom),fields]);
}
export interface EvidenceSource {
  readonly documentKey: string;
  readonly nativeSourceSha256: string;
  readonly savedSourceSha256: string;
}
export interface NativeFootprintPads {
  readonly instanceUuid: string;
  readonly reference: string;
  /** Complete decoded native Pad records, not a shape/layer projection. */
  readonly pads: readonly JsonObject[];
}
export interface LayerPresenceCapture {
  readonly source: EvidenceSource;
  readonly requestedPadUuids: readonly string[];
  readonly requestedLayers: readonly string[];
  readonly observations: readonly {
    readonly padUuid: string;
    readonly layer: string;
    readonly presence: 'present' | 'absent' | 'unknown';
  }[];
}
export interface PadInventoryInput {
  readonly source: EvidenceSource;
  readonly enabledCopperLayers: readonly string[];
  readonly footprints: readonly NativeFootprintPads[];
  readonly layerPresence?: LayerPresenceCapture;
}
export interface PhysicalPad {
  readonly uuid: string;
  readonly footprintUuid: string;
  readonly reference: string;
  readonly number: string;
  readonly nativeType: string;
  readonly netName: string | null;
  readonly layerMembership: readonly string[];
  readonly declaredEnabledCopperLayers: readonly string[];
  /** Null means native layer-presence evidence is unavailable/ambiguous. */
  readonly observedUsableCopperLayers: readonly string[] | null;
  readonly role: 'numbered-copper' | 'paste-aperture' | 'mechanical-hole' | 'unsupported-physical';
  readonly issues: readonly string[];
  /** Preserves every field, including shapes, paste, drills, positions, UUID and unknown extensions. */
  readonly rawNative: JsonObject;
}
export interface LogicalTerminal {
  readonly key: string;
  readonly footprintUuid: string;
  readonly reference: string;
  readonly number: string;
  readonly physicalPadUuids: readonly string[];
  readonly net: { readonly status: 'assigned' | 'unassigned' | 'conflict'; readonly names: readonly (string | null)[] };
  readonly eligibleForPinMatching: boolean;
  readonly copperCommon: 'not-assessed';
  readonly componentInternalConnectivity: 'unknown';
}
export interface PadInventory {
  readonly schemaVersion: 'evleda.pcb-pad-terminal-inventory.v1';
  readonly source: EvidenceSource;
  readonly physicalPads: readonly PhysicalPad[];
  readonly terminals: readonly LogicalTerminal[];
  readonly nonElectricalFeatureUuids: readonly string[];
  readonly unsupportedPhysicalUuids: readonly string[];
  readonly footprintUuids: readonly string[];
  readonly rawLayerPresence: LayerPresenceCapture | null;
}
export interface NativePadClusterQuery {
  readonly id: string;
  readonly sourceUuids: readonly string[];
  readonly filterTypes: readonly string[];
  readonly status: 'complete' | 'failed';
  readonly returnedPadUuids: readonly string[];
  /** Raw caller-captured query/response retained even when not valid proof. */
  readonly rawCapture: JsonObject;
}
export interface NativePadClusterCapture {
  readonly source: EvidenceSource;
  readonly queries: readonly NativePadClusterQuery[];
}
export interface CopperCommonRequest {
  readonly terminalKey: string;
  /** Explicit subset; no implicit requirement that every same-number pad must be shorted. */
  readonly requiredPhysicalPadUuids: readonly string[];
}
export interface CopperCommonAssessment {
  readonly status: 'connected' | 'disconnected' | 'unproven' | 'unsupported' | 'invalid-evidence';
  readonly request: CopperCommonRequest;
  readonly reasons: readonly string[];
  readonly usedSingleSourceQueryIds: readonly string[];
  readonly ignoredUnionQueryIds: readonly string[];
  readonly externalConnectedPadUuids: readonly string[];
  readonly capture: NativePadClusterCapture | null;
  readonly componentInternalConnectivity: 'not-inferred';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COPPER = /^BL_(?:F|B|In(?:[1-9]|[12][0-9]|30))_Cu$/u;
const PASTE = new Set(['BL_F_Paste', 'BL_B_Paste']);
const SHAPES = new Set(['PSS_CIRCLE', 'PSS_OVAL', 'PSS_RECTANGLE', 'PSS_ROUNDRECT']);
const MAX_PADS = 4096;
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function boundedText(value: unknown, label: string, allowEmpty = false): string {
  requireCondition(typeof value === 'string' && value.length <= 1024 && (allowEmpty || value.length > 0) && !/[\u0000-\u001f]/u.test(value), 'Invalid ' + label);
  return value;
}
function unique(values: readonly string[], label: string): void {
  requireCondition(new Set(values).size === values.length, 'Duplicate ' + label);
}
function sourceKey(source: EvidenceSource): string {
  boundedText(source.documentKey, 'document key');
  requireCondition(/^[0-9a-f]{64}$/u.test(source.nativeSourceSha256) && /^[0-9a-f]{64}$/u.test(source.savedSourceSha256), 'Invalid source digest');
  return JSON.stringify([source.documentKey, source.nativeSourceSha256, source.savedSourceSha256]);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Inputs/outputs are JSON data; clone without a Node/DOM runtime dependency. */
function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(child => cloneJson(child)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)])) as T;
  return value;
}
function cloneFrozen<T>(value: T): T { return freeze(cloneJson(value)); }
function nm(value: JsonValue | undefined): number | null {
  if (value === undefined) return 0; // Proto scalar default, not a missing geometry object.
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?[0-9]+$/u.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function size(objectValue: JsonObject): [number | null, number | null] { return [nm(objectValue.x_nm), nm(objectValue.y_nm)]; }
function terminalKey(footprintUuid: string, number: string): string { return JSON.stringify([footprintUuid, number]); }

export function buildPadTerminalInventory(input: PadInventoryInput): PadInventory {
  const source = sourceKey(input.source);
  requireCondition(input.footprints.length > 0 && input.footprints.length <= 512, 'Unsupported footprint count');
  requireCondition(input.enabledCopperLayers.length > 0 && input.enabledCopperLayers.length <= 32 && input.enabledCopperLayers.every(l => COPPER.test(l)), 'Invalid enabled copper layers');
  unique(input.enabledCopperLayers, 'enabled copper layer');
  unique(input.footprints.map(fp => fp.instanceUuid), 'footprint UUID');
  unique(input.footprints.map(fp => fp.reference), 'footprint reference');
  const allPadUuids = input.footprints.flatMap(fp => fp.pads.map(raw => boundedText(object(raw.id).value, 'pad UUID')));
  requireCondition(allPadUuids.length > 0 && allPadUuids.length <= MAX_PADS && allPadUuids.every(id => UUID.test(id)), 'Unsupported physical pad UUID inventory');
  unique(allPadUuids, 'physical pad UUID');
  const presence = new Map<string, string>();
  if (input.layerPresence) {
    const capture = input.layerPresence;
    requireCondition(sourceKey(capture.source) === source, 'Layer presence source mismatch');
    unique(capture.requestedPadUuids, 'presence request pad');
    unique(capture.requestedLayers, 'presence request layer');
    requireCondition(capture.requestedPadUuids.every(id => allPadUuids.includes(id)), 'Presence request contains unknown pad');
    requireCondition(capture.requestedLayers.length > 0 && capture.requestedLayers.length <= 64, 'Invalid presence layer request');
    for (const observation of capture.observations) {
      requireCondition(capture.requestedPadUuids.includes(observation.padUuid) && capture.requestedLayers.includes(observation.layer), 'Unrequested layer-presence observation');
      const key = JSON.stringify([observation.padUuid, observation.layer]);
      requireCondition(!presence.has(key), 'Duplicate layer-presence observation');
      requireCondition(['present', 'absent', 'unknown'].includes(observation.presence), 'Invalid layer-presence enum');
      presence.set(key, observation.presence);
    }
  }
  const physical: PhysicalPad[] = [];
  for (const fp of input.footprints) {
    requireCondition(UUID.test(fp.instanceUuid), 'Invalid footprint UUID');
    boundedText(fp.reference, 'footprint reference');
    for (const raw of fp.pads) {
      const uuid = String(object(raw.id).value);
      const number = boundedText(raw.number ?? '', 'terminal number', true);
      const netName = boundedText(object(raw.net).name ?? '', 'net name', true) || null;
      const nativeType = boundedText(raw.type ?? '', 'native pad type', true);
      const stack = object(raw.pad_stack);
      const rawLayers = stack.layers;
      requireCondition(Array.isArray(rawLayers) && rawLayers.every(l => typeof l === 'string'), 'Missing/invalid actual pad-stack layers');
      const layers = rawLayers as readonly string[];
      unique(layers, 'physical pad layer');
      const declared = input.enabledCopperLayers.filter(l => layers.includes(l));
      const issues: string[] = [];
      if (!['PT_PTH', 'PT_SMD', 'PT_NPTH'].includes(nativeType)) issues.push('uncharacterized-pad-type');
      if (stack.type !== 'PST_NORMAL') issues.push('uncharacterized-pad-stack-mode');
      if (layers.length === 0 || layers.length > 64 || layers.some(l => !COPPER.test(l) && !PASTE.has(l) && !['BL_F_Mask', 'BL_B_Mask'].includes(l))) issues.push('uncharacterized-layer-membership');
      const geometry = stack.copper_layers;
      if (!Array.isArray(geometry) || geometry.length === 0 || geometry.some(entry => {
        const shape = object(entry), dimensions = size(object(shape.size));
        return !SHAPES.has(String(shape.shape)) || dimensions.some(value => value === null || value <= 0)
          || shape.shape === 'PSS_CIRCLE' && dimensions[0] !== dimensions[1];
      })) issues.push('uncharacterized-or-invalid-shape-geometry');
      if (size(object(raw.position)).some(v => v === null)) issues.push('invalid-native-position');
      const drillRecord = object(stack.drill), drill = size(object(drillRecord.diameter));
      const drilled = nativeType === 'PT_PTH' || nativeType === 'PT_NPTH';
      if (drill.some(v => v === null || v < 0) || (drilled ? drill.some(v => v === 0) : drill.some(v => v !== 0))
          || drilled && (!['DS_CIRCLE', 'DS_OBLONG'].includes(String(drillRecord.shape))
            || drillRecord.shape === 'DS_CIRCLE' && drill[0] !== drill[1])) issues.push('unsupported-pad-drill-combination');
      const angle = object(stack.angle).value_degrees ?? 0;
      if (typeof angle !== 'number' || !Number.isFinite(angle)) issues.push('invalid-native-angle');
      let observed: readonly string[] | null = null;
      if (input.layerPresence) {
        const states = input.enabledCopperLayers.map(layer => ({layer, state: presence.get(JSON.stringify([uuid, layer]))}));
        if (states.some(p => p.state === undefined || p.state === 'unknown')) issues.push('incomplete-or-unknown-native-copper-presence');
        else if (states.some(p => p.state === 'present' && !layers.includes(p.layer))) issues.push('native-presence-contradicts-layer-membership');
        else observed = states.filter(p => p.state === 'present').map(p => p.layer);
      }
      const pasteOnly = !number && netName === null && nativeType === 'PT_SMD' && layers.length > 0 && layers.every(l => PASTE.has(l));
      // KiCad 10 NPTH locating holes retain their complete pad-stack records and
      // layer selectors, but are not electrical terminals. Bound this support to
      // a centered circle/oval bore exactly covering the matching pad shape;
      // NPTH annular copper and offsets need separate geometry characterization.
      const holeShape = Array.isArray(geometry) && geometry.length === 1 ? object(geometry[0]) : {};
      const holeSize = size(object(holeShape.size)), holeOffset = size(object(holeShape.offset));
      const rawNetCode = object(raw.net).code;
      const netCodeUnassigned = rawNetCode === undefined || rawNetCode !== null && typeof rawNetCode === 'object' && !Array.isArray(rawNetCode)
        && Object.keys(rawNetCode).every(key => key === 'value') && (object(rawNetCode).value === undefined || object(rawNetCode).value === 0);
      const mechanicalHole = nativeType === 'PT_NPTH' && !number && netName === null && netCodeUnassigned
        && stack.type === 'PST_NORMAL' && declared.length > 0 && layers.every(l => COPPER.test(l) || ['BL_F_Mask', 'BL_B_Mask'].includes(l))
        && ((holeShape.shape === 'PSS_CIRCLE' && drillRecord.shape === 'DS_CIRCLE') || (holeShape.shape === 'PSS_OVAL' && drillRecord.shape === 'DS_OBLONG'))
        && holeSize.every((value, index) => value !== null && value > 0 && value === drill[index])
        && holeOffset.every(value => value === 0) && drillRecord.start_layer === 'BL_F_Cu' && drillRecord.end_layer === 'BL_B_Cu';
      if (nativeType === 'PT_NPTH' && !mechanicalHole) issues.push('unsupported-mechanical-hole-geometry-or-disposition');
      if (mechanicalHole && observed !== null && observed.length > 0) issues.push('mechanical-hole-contradicts-native-copper-presence');
      // The raw presence response remains in rawLayerPresence. Even an invalid
      // NPTH record cannot acquire electrical usable copper or terminal identity.
      if (nativeType === 'PT_NPTH') observed = [];
      const role = mechanicalHole ? 'mechanical-hole' : number && declared.length > 0 && nativeType !== 'PT_NPTH' ? 'numbered-copper' : pasteOnly ? 'paste-aperture' : 'unsupported-physical';
      if (role === 'unsupported-physical') issues.push('uncharacterized-number-layer-or-net-disposition');
      physical.push({uuid, footprintUuid: fp.instanceUuid, reference: fp.reference, number, nativeType, netName,
        layerMembership: layers, declaredEnabledCopperLayers: declared, observedUsableCopperLayers: observed,
        role, issues, rawNative: raw});
    }
  }
  const grouped = new Map<string, PhysicalPad[]>();
  for (const pad of physical) if (pad.role === 'numbered-copper') {
    const key = terminalKey(pad.footprintUuid, pad.number);
    grouped.set(key, [...(grouped.get(key) ?? []), pad]);
  }
  const terminals: LogicalTerminal[] = [...grouped].map(([key, members]) => {
    const first = members[0]!;
    const names = [...new Set(members.map(p => p.netName))];
    return {key, footprintUuid: first.footprintUuid, reference: first.reference, number: first.number,
      physicalPadUuids: members.map(p => p.uuid), net: {status: names.length > 1 ? 'conflict' : names[0] === null ? 'unassigned' : 'assigned', names},
      eligibleForPinMatching: names.length === 1 && members.every(p => p.issues.length === 0),
      copperCommon: 'not-assessed', componentInternalConnectivity: 'unknown'};
  });
  return cloneFrozen({schemaVersion: 'evleda.pcb-pad-terminal-inventory.v1', source: input.source, physicalPads: physical, terminals,
    nonElectricalFeatureUuids: physical.filter(p => p.role === 'paste-aperture' || p.role === 'mechanical-hole').map(p => p.uuid),
    unsupportedPhysicalUuids: physical.filter(p => p.role === 'unsupported-physical' || p.issues.length > 0).map(p => p.uuid),
    footprintUuids: input.footprints.map(fp => fp.instanceUuid), rawLayerPresence: input.layerPresence ?? null});
}

export function matchLogicalTerminalNumbers(inventory: PadInventory, footprintUuid: string, expected: readonly string[]): {
  readonly status: 'match' | 'mismatch' | 'unsupported'; readonly expected: readonly string[]; readonly observed: readonly string[];
} {
  requireCondition(inventory.footprintUuids.includes(footprintUuid), 'Unknown footprint');
  requireCondition(expected.length > 0 && expected.every(p => boundedText(p, 'expected terminal number').length > 0), 'Invalid expected terminal set');
  unique(expected, 'expected terminal');
  const terminals = inventory.terminals.filter(t => t.footprintUuid === footprintUuid);
  const observed = terminals.map(t => t.number);
  const unsupported = terminals.some(t => !t.eligibleForPinMatching) || inventory.physicalPads.some(p => p.footprintUuid === footprintUuid && inventory.unsupportedPhysicalUuids.includes(p.uuid));
  return cloneFrozen({status: unsupported ? 'unsupported' : expected.length === observed.length && expected.every(p => observed.includes(p)) ? 'match' : 'mismatch', expected, observed});
}

export function assessCopperCommon(inventory: PadInventory, request: CopperCommonRequest, capture?: NativePadClusterCapture): CopperCommonAssessment {
  const used: string[] = [], unions: string[] = [], external = new Set<string>();
  const result = (status: CopperCommonAssessment['status'], ...reasons: string[]): CopperCommonAssessment => cloneFrozen({
    status, request, reasons, usedSingleSourceQueryIds: used, ignoredUnionQueryIds: unions,
    externalConnectedPadUuids: [...external], capture: capture ?? null, componentInternalConnectivity: 'not-inferred'});
  const terminal = inventory.terminals.find(t => t.key === request.terminalKey);
  if (!terminal || request.requiredPhysicalPadUuids.length === 0 || new Set(request.requiredPhysicalPadUuids).size !== request.requiredPhysicalPadUuids.length || request.requiredPhysicalPadUuids.some(id => !terminal.physicalPadUuids.includes(id))) return result('unsupported', 'Request must explicitly name unique physical members of one known terminal.');
  if (!terminal.eligibleForPinMatching || terminal.net.status !== 'assigned') return result('unsupported', 'Terminal geometry or net disposition is unresolved; no internal component tie is assumed.');
  const requestedPads = inventory.physicalPads.filter(p => request.requiredPhysicalPadUuids.includes(p.uuid));
  if (requestedPads.some(p => p.observedUsableCopperLayers === null)) return result('unproven', 'Required native copper-layer presence evidence is unavailable.');
  if (requestedPads.some(p => p.observedUsableCopperLayers?.length === 0)) return result('unsupported', 'A requested primitive has no observed usable copper layer.');
  if (!capture) return result('unproven', 'No native single-source cluster capture supplied.');
  if (sourceKey(capture.source) !== sourceKey(inventory.source)) return result('invalid-evidence', 'Native cluster source mismatch.');
  if (capture.queries.length > MAX_PADS * 4 || new Set(capture.queries.map(q => q.id)).size !== capture.queries.length) return result('invalid-evidence', 'Invalid or duplicate query inventory.');
  const physical = new Map(inventory.physicalPads.map(p => [p.uuid, p]));
  const required = request.requiredPhysicalPadUuids;
  const bySource = new Map<string, NativePadClusterQuery>();
  for (const query of capture.queries) {
    if (!query.sourceUuids.some(id => required.includes(id))) continue;
    if (query.sourceUuids.length > 1) { unions.push(query.id); continue; }
    const source = query.sourceUuids[0]!;
    if (bySource.has(source)) return result('invalid-evidence', 'More than one single-source observation for a required primitive.');
    if (query.status !== 'complete' || query.filterTypes.length !== 1 || query.filterTypes[0] !== 'KOT_PCB_PAD') return result('unproven', 'A required query failed or did not use the explicit PAD filter.');
    if (new Set(query.returnedPadUuids).size !== query.returnedPadUuids.length || !query.returnedPadUuids.includes(source) || query.returnedPadUuids.some(id => !physical.has(id))) return result('invalid-evidence', 'Native cluster has missing source, duplicate, or unbound physical UUIDs.');
    if (query.returnedPadUuids.some(id => physical.get(id)!.role !== 'numbered-copper' || physical.get(id)!.netName !== terminal.net.names[0])) return result('invalid-evidence', 'Native cluster contains a non-electrical feature or unexpected net; connectivity cannot hide a short.');
    bySource.set(source, query); used.push(query.id);
    for (const id of query.returnedPadUuids) if (!required.includes(id)) external.add(id);
  }
  if (bySource.size !== required.length) return result('unproven', 'Every requested physical primitive needs its own native query; unions are not proof.');
  // Complete native PAD clusters from one bound observation form a partition:
  // if any physical member is shared, the entire sets must be identical. Check
  // all complete single-source observations, including sources outside the
  // requested subset; a shared third member can expose a contradictory capture.
  const completeClusterByMember = new Map<string, ReadonlySet<string>>();
  for (const query of capture.queries) {
    if (query.status !== 'complete' || query.sourceUuids.length !== 1 || query.filterTypes.length !== 1 || query.filterTypes[0] !== 'KOT_PCB_PAD') continue;
    const members = new Set(query.returnedPadUuids);
    for (const member of members) {
      const previous = completeClusterByMember.get(member);
      if (previous && (previous.size !== members.size || [...previous].some(id => !members.has(id)))) return result('invalid-evidence', 'Intersecting complete native PAD clusters disagree about their full membership.');
      completeClusterByMember.set(member, members);
    }
  }
  for (const a of required) for (const b of required) {
    const qa = bySource.get(a)!, qb = bySource.get(b)!;
    if (qa.returnedPadUuids.includes(b) !== qb.returnedPadUuids.includes(a)) return result('invalid-evidence', 'Native same-source cluster observations are asymmetric.');
    if (qa.returnedPadUuids.includes(b) && (qa.returnedPadUuids.length !== qb.returnedPadUuids.length || qa.returnedPadUuids.some(id => !qb.returnedPadUuids.includes(id)))) return result('invalid-evidence', 'Connected primitive observations disagree about the complete native cluster.');
  }
  return required.every(a => required.every(b => bySource.get(a)!.returnedPadUuids.includes(b)))
    ? result('connected', 'Every explicitly requested physical member appears in every member-specific native copper cluster.')
    : result('disconnected', 'Complete native single-source evidence shows separate copper clusters; component-internal ties remain unknown.');
}

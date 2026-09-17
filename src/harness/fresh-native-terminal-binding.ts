import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { FreshConnectivityContract, FreshConnectivityEndpoint } from "./fresh-connectivity-contract.js";
import { parseFreshNetlistSource, type FreshParsedPcb } from "./fresh-kicad-parser.js";

export const FRESH_NATIVE_TERMINAL_BINDING_SCHEMA_VERSION = "evleda.fresh-native-terminal-binding.v1" as const;

/** Structurally compatible with the harness's connectivity findings, without importing the harness. */
export interface FreshNativeNetlistParityIssue {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly endpoints?: readonly string[];
}

export interface FreshNativeTerminalBinding {
  readonly schemaVersion: typeof FRESH_NATIVE_TERMINAL_BINDING_SCHEMA_VERSION;
  readonly contractIdentity: CanonicalIdentity;
  readonly nativeNetlistContentIdentity: ContentIdentity;
  readonly scopeIdentity: CanonicalIdentity;
  readonly endpoints: readonly Readonly<FreshConnectivityEndpoint & { readonly nativeNetName: string }>[];
  readonly identity: CanonicalIdentity;
}

const authenticatedBindings = new WeakSet<object>();
const endpointId = (endpoint: FreshConnectivityEndpoint): string => `${endpoint.reference}:${endpoint.pin}`;
const endpointKey = (endpoint: FreshConnectivityEndpoint): string => JSON.stringify([endpoint.reference, endpoint.pin]);
const freezeDeep = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};

function inspectNativeParity(contract: FreshConnectivityContract, source: string) {
  const native = parseFreshNetlistSource(source);
  // KiCad serializes electrical-type annotations with '+'. A name (including
  // an unconnected-* prefix) contributes no evidence of an intentional NC.
  const intentionalNoConnectNets = native.nets.filter((net) =>
    net.nodes.length === 1 && net.nodes[0]!.pinType.split("+").includes("no_connect"),
  );
  const ncNets = new Set(intentionalNoConnectNets);
  const functionalNets = native.nets.filter((net) => !ncNets.has(net));
  const expectedReferences = contract.components.map((component) => component.reference).sort();
  const actualReferences = [...native.references].sort();
  const issues: FreshNativeNetlistParityIssue[] = [];
  if (JSON.stringify(actualReferences) !== JSON.stringify(expectedReferences)) issues.push({
    code: "NATIVE_COMPONENT_PARITY_MISMATCH",
    message: "Native KiCad netlist component references do not exactly match the host contract.",
    remediation: "Keep completion blocked and restore the last trusted fresh checkpoint.",
    endpoints: expectedReferences,
  });
  const components = new Map(native.components.map((component) => [component.reference, component]));
  for (const component of contract.components) {
    const observed = components.get(component.reference);
    if (observed === undefined || observed.symbolLibId !== component.symbolLibId
      || observed.value !== component.value || observed.footprintLibId !== component.footprintLibId) issues.push({
      code: "NATIVE_COMPONENT_IDENTITY_PARITY_MISMATCH",
      message: `Native KiCad netlist identity for ${component.reference} does not exactly match its contract library, value, and footprint.`,
      remediation: "Keep completion blocked and restore the last trusted fresh checkpoint.",
      endpoints: [component.reference],
    });
  }
  const expectedNames = contract.nets.map((net) => net.name).sort();
  const actualNames = functionalNets.map((net) => net.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) issues.push({
    code: "NATIVE_NET_NAME_PARITY_MISMATCH",
    message: "Native KiCad netlist names do not exactly match the host contract.",
    remediation: "Keep completion blocked; provider prose or sidecar-only readback cannot override native parity.",
  });
  const functionalByName = new Map(functionalNets.map((net) => [net.name, net]));
  for (const net of contract.nets) {
    const expected = net.endpoints.map(endpointKey).sort();
    const actual = (functionalByName.get(net.name)?.nodes ?? []).map(endpointKey).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push({
      code: "NATIVE_NET_ENDPOINT_PARITY_MISMATCH",
      message: `Native KiCad netlist endpoints for ${net.name} do not exactly match the host contract.`,
      remediation: "Keep completion blocked and restore the pre-connectivity schematic.",
      endpoints: net.endpoints.map(endpointId).sort(),
    });
  }
  const actualNoConnects = intentionalNoConnectNets.map((net) => endpointKey(net.nodes[0]!)).sort();
  const expectedNoConnects = contract.noConnects.map(endpointKey).sort();
  const malformedNoConnect = native.nets.some(net=>net.nodes.some(node=>node.pinType.split("+").includes("no_connect"))
    && (net.nodes.length!==1||!expectedNoConnects.includes(endpointKey(net.nodes[0]!))));
  if (malformedNoConnect || JSON.stringify(actualNoConnects) !== JSON.stringify(expectedNoConnects)) issues.push({
    code: "NATIVE_NO_CONNECT_PARITY_MISMATCH",
    message: "Native KiCad singleton no-connect endpoints do not exactly match the host contract.",
    remediation: "Keep completion blocked and restore the pre-connectivity schematic.",
    endpoints: contract.noConnects.map(endpointId).sort(),
  });
  return { issues, intentionalNoConnectNets };
}

/** Complete native component, identity, functional-net and intentional-NC parity. */
export function freshNativeNetlistParityIssues(
  contract: FreshConnectivityContract,
  source: string,
): readonly FreshNativeNetlistParityIssue[] {
  return inspectNativeParity(contract, source).issues;
}

/**
 * Only a fully matching native export may qualify terminal names. The caller
 * captures this source under its project/library guard and passes the same
 * current scope when consuming the binding; this pure helper performs no IO.
 */
export function createFreshNativeTerminalBinding(
  contract: FreshConnectivityContract,
  nativeNetlistSource: string,
  scopeIdentity: CanonicalIdentity,
): FreshNativeTerminalBinding {
  const {identity:claimedContractIdentity,...contractPayload}=contract;
  if(canonicalJson(canonicalIdentity(contractPayload,contract.schemaVersion))!==canonicalJson(claimedContractIdentity))throw new Error("Fresh native terminal binding contract content identity is invalid.");
  const { issues, intentionalNoConnectNets } = inspectNativeParity(contract, nativeNetlistSource);
  if (issues.length !== 0) throw new Error(
    `Fresh native terminal binding requires complete native netlist parity: ${issues.map((issue) => issue.code).join(", ")}.`,
  );
  const endpoints = intentionalNoConnectNets.map((net) => ({
    reference: net.nodes[0]!.reference, pin: net.nodes[0]!.pin, nativeNetName: net.name,
  })).sort((left, right) => {
    const a = endpointKey(left), b = endpointKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const payload = {
    schemaVersion: FRESH_NATIVE_TERMINAL_BINDING_SCHEMA_VERSION,
    contractIdentity: { ...contract.identity },
    nativeNetlistContentIdentity: contentIdentity(nativeNetlistSource),
    scopeIdentity: { ...scopeIdentity },
    endpoints,
  };
  const binding = freezeDeep({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  authenticatedBindings.add(binding);
  return binding;
}

/** Serialized, spread or otherwise forged lookalikes never carry authority. */
export function validateCurrentFreshNativeTerminalBinding(
  binding: unknown,
  contractIdentity: CanonicalIdentity,
  scopeIdentity: CanonicalIdentity,
): asserts binding is FreshNativeTerminalBinding {
  if (binding === null || typeof binding !== "object" || !authenticatedBindings.has(binding)) {
    throw new Error("Fresh native terminal binding is not authenticated in this process.");
  }
  const current = binding as FreshNativeTerminalBinding;
  if (canonicalJson(current.contractIdentity) !== canonicalJson(contractIdentity)
    || canonicalJson(current.scopeIdentity) !== canonicalJson(scopeIdentity)) {
    throw new Error("Fresh native terminal binding contract or scope is stale.");
  }
}

/**
 * NC membership is logical, so every repeated physical pad is allowed only on
 * the exact qualified name. No other terminal or routed copper may use it.
 */
export function assertFreshNativeNoConnectPcbIsolation(
  binding: FreshNativeTerminalBinding,
  board: FreshParsedPcb,
): void {
  validateCurrentFreshNativeTerminalBinding(binding, binding.contractIdentity, binding.scopeIdentity);
  const padsByEndpoint = new Map<string, Array<string | null>>();
  const endpointsByNet = new Map<string, Set<string>>();
  for (const footprint of board.footprints) for (const pad of footprint.pads) {
    const key = endpointKey({ reference: footprint.reference, pin: pad.number });
    const names = padsByEndpoint.get(key) ?? [];
    names.push(pad.netName);
    padsByEndpoint.set(key, names);
    if (pad.netName !== null) {
      const endpoints = endpointsByNet.get(pad.netName) ?? new Set<string>();
      endpoints.add(key);
      endpointsByNet.set(pad.netName, endpoints);
    }
  }
  const copperNets = new Set([
    ...board.segments.map((segment) => segment.netName),
    ...board.vias.map((via) => via.netName),
    ...board.zoneNetNames,
  ]);
  for (const endpoint of binding.endpoints) {
    const key = endpointKey(endpoint);
    const names = padsByEndpoint.get(key);
    if (names === undefined || names.length === 0 || names.some((name) => name !== endpoint.nativeNetName)) {
      throw new Error(`Fresh native no-connect ${endpointId(endpoint)} requires every physical pad on exact native net ${endpoint.nativeNetName}.`);
    }
    const members = endpointsByNet.get(endpoint.nativeNetName)!;
    if (members.size !== 1 || !members.has(key)) {
      throw new Error(`Fresh native no-connect net ${endpoint.nativeNetName} contains another logical terminal.`);
    }
    if (copperNets.has(endpoint.nativeNetName)) {
      throw new Error(`Fresh native no-connect net ${endpoint.nativeNetName} contains track, via, or zone copper.`);
    }
  }
}

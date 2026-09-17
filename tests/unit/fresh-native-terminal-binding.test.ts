import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION, type FreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import {
  assertFreshNativeNoConnectPcbIsolation,
  createFreshNativeTerminalBinding,
  freshNativeNetlistParityIssues,
  validateCurrentFreshNativeTerminalBinding,
  type FreshNativeTerminalBinding,
} from "../../src/harness/fresh-native-terminal-binding.js";

// Pure source fixtures: these tests make no native execution or hardware claim.
const contractPayload = {
  schemaVersion: FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION,
  sourceContractIdentity: canonicalIdentity({ fixture: "NC" }, "fixture.v1"),
  components: ["J1", "R1"].map((reference) => ({ reference, symbolLibId: "Fixture:TwoPins", value: "TEST", footprintLibId: "Fixture:TwoPads" })),
  nets: [{ name: "LINK", endpoints: [{ reference: "J1", pin: "1" }, { reference: "R1", pin: "1" }] }],
  noConnects: [{ reference: "J1", pin: "2" }, { reference: "R1", pin: "2" }],
};
const contract: FreshConnectivityContract = { ...contractPayload, identity: canonicalIdentity(contractPayload, contractPayload.schemaVersion) };
const scope = canonicalIdentity({ project: "one", schematic: "one", libraries: "one" }, "fixture.scope.v1");
const firstName = "arbitrary native terminal name";
const secondName = "another-terminal";
const node = (reference: string, pin: string, pinType = "passive") => `(node (ref ${JSON.stringify(reference)}) (pin ${JSON.stringify(pin)}) (pintype ${JSON.stringify(pinType)}))`;
const net = (name: string, nodes: string) => `(net (name ${JSON.stringify(name)}) ${nodes})`;
const firstNc = net(firstName, node("J1", "2", "passive+no_connect"));
const secondNc = net(secondName, node("R1", "2", "no_connect"));
const functional = net("LINK", node("J1", "1") + node("R1", "1"));
const source = `(export (components ${contract.components.map((component) => `(comp (ref "${component.reference}") (value "TEST") (footprint "Fixture:TwoPads") (libsource (lib "Fixture") (part "TwoPins")))`).join(" ")}) (nets ${functional} ${firstNc} ${secondNc}))`;
const binding = () => createFreshNativeTerminalBinding(contract, source, scope);
const pad = (pin: string, name: string | null) => `(pad ${JSON.stringify(pin)} smd rect (at 0 0) (size 1 1) (layers "F.Cu") ${name === null ? "" : `(net ${JSON.stringify(name)})`})`;
const footprint = (reference: string, pads: string) => `(footprint "Fixture:TwoPads" (layer "F.Cu") (at 10 10) (property "Reference" "${reference}") (property "Value" "TEST") ${pads})`;
const board = (options: { firstPads?: string; extraPads?: string; extraCopper?: string } = {}) => parseFreshPcbSource(
  `(kicad_pcb (version 20260206) ${footprint("J1", pad("1", "LINK") + (options.firstPads ?? pad("2", firstName)) + (options.extraPads ?? ""))} ${footprint("R1", pad("1", "LINK") + pad("2", secondName))} ${options.extraCopper ?? ""})`,
);

describe("qualified fresh native terminal bindings", () => {
  it("rejects altered contract content retaining a legitimate claimed identity before minting authority", () => {
    const changed={...contract,noConnects:[]};
    const ncFreeSource=source.replace(firstNc,"").replace(secondNc,"");
    expect(freshNativeNetlistParityIssues(changed,ncFreeSource)).toEqual([]);
    expect(()=>createFreshNativeTerminalBinding(changed,ncFreeSource,scope)).toThrow(/contract content identity is invalid/);
  });

  it("qualifies arbitrary exact native names only after complete component/net/NC parity", () => {
    expect(freshNativeNetlistParityIssues(contract, source)).toEqual([]);
    const qualified = binding();
    expect(qualified.endpoints).toEqual([
      { reference: "J1", pin: "2", nativeNetName: firstName },
      { reference: "R1", pin: "2", nativeNetName: secondName },
    ]);
    expect(qualified.contractIdentity).toEqual(contract.identity);
    expect(qualified.nativeNetlistContentIdentity).toEqual(contentIdentity(source));
    expect(qualified.scopeIdentity).toEqual(scope);
    const { identity, ...payload } = qualified;
    expect(identity).toEqual(canonicalIdentity(payload, qualified.schemaVersion));
    expect(binding().identity).toEqual(identity);
    expect(() => validateCurrentFreshNativeTerminalBinding(qualified, contract.identity, scope)).not.toThrow();
  });

  it.each(["no_connect", "passive+no_connect", "no_connect+passive"])("uses exact '+' separated %s tokens", (pinType) => {
    expect(() => createFreshNativeTerminalBinding(contract, source.replace("passive+no_connect", pinType), scope)).not.toThrow();
  });

  it.each(["passive", "passive+no_connection", "passive+not_no_connect", "passive+no_connect_suffix", "passive,no_connect", "passive+ no_connect"])("rejects prefixed-name impostors with %s type", (pinType) => {
    const impostor = source.replace(firstName, "unconnected-(J1-Pin_2-Pad2)").replace("passive+no_connect", pinType);
    expect(freshNativeNetlistParityIssues(contract, impostor).map((issue) => issue.code)).toContain("NATIVE_NO_CONNECT_PARITY_MISMATCH");
    expect(() => createFreshNativeTerminalBinding(contract, impostor, scope)).toThrow(/complete native netlist parity/u);
  });

  it("retains a conventional native name exactly when it has qualifying node evidence", () => {
    const name = "unconnected-(arbitrary-prefix-does-not-infer-endpoint)";
    expect(createFreshNativeTerminalBinding(contract, source.replace(firstName, name), scope).endpoints[0]!.nativeNetName).toBe(name);
  });

  it.each([
    ["wrong pin", firstNc, net(firstName, node("J1", "9", "no_connect"))],
    ["wrong reference", firstNc, net(firstName, node("J9", "2", "no_connect"))],
    ["missing NC", firstNc, ""],
    ["multi-node NC", `${firstNc} ${secondNc}`, net(firstName, node("J1", "2", "no_connect") + node("R1", "2", "no_connect"))],
    ["extra NC", firstNc, firstNc + net("extra", node("J1", "3", "no_connect"))],
  ])("rejects %s topology", (_label, before, after) => {
    const invalid = source.replace(before, after);
    expect(freshNativeNetlistParityIssues(contract, invalid).map((issue) => issue.code)).toContain("NATIVE_NO_CONNECT_PARITY_MISMATCH");
    expect(() => createFreshNativeTerminalBinding(contract, invalid, scope)).toThrow();
  });

  it.each([
    ["duplicate endpoint on another net", firstNc + net("duplicated", node("J1", "2", "no_connect"))],
    ["duplicate endpoint on same net", net(firstName, node("J1", "2", "no_connect") + node("J1", "2", "no_connect"))],
    ["duplicate native net name", firstNc + net(firstName, node("J1", "3", "no_connect"))],
  ])("fails closed for %s", (_label, replacement) => {
    expect(() => createFreshNativeTerminalBinding(contract, source.replace(firstNc, replacement), scope)).toThrow(/multiple nets|duplicate net names/u);
  });

  it.each([
    ["component reference", '(comp (ref "R1")', '(comp (ref "R9")', "NATIVE_COMPONENT_PARITY_MISMATCH"],
    ["component value", '(value "TEST")', '(value "OTHER")', "NATIVE_COMPONENT_IDENTITY_PARITY_MISMATCH"],
    ["symbol library", '(lib "Fixture")', '(lib "Other")', "NATIVE_COMPONENT_IDENTITY_PARITY_MISMATCH"],
    ["symbol part", '(part "TwoPins")', '(part "ThreePins")', "NATIVE_COMPONENT_IDENTITY_PARITY_MISMATCH"],
    ["footprint", '(footprint "Fixture:TwoPads")', '(footprint "Fixture:Other")', "NATIVE_COMPONENT_IDENTITY_PARITY_MISMATCH"],
    ["functional name", '(name "LINK")', '(name "OTHER")', "NATIVE_NET_NAME_PARITY_MISMATCH"],
    ["functional pin", '(pin "1")', '(pin "9")', "NATIVE_NET_ENDPOINT_PARITY_MISMATCH"],
  ])("blocks NC qualification on unrelated %s parity failure", (_label, before, after, code) => {
    const invalid = source.replace(before, after);
    expect(freshNativeNetlistParityIssues(contract, invalid).map((issue) => issue.code)).toContain(code);
    expect(() => createFreshNativeTerminalBinding(contract, invalid, scope)).toThrow(/complete native netlist parity/u);
  });

  it("binds exact export content, including harmless whitespace", () => {
    const other = createFreshNativeTerminalBinding(contract, `${source}\n`, scope);
    expect(other.endpoints).toEqual(binding().endpoints);
    expect(other.nativeNetlistContentIdentity).not.toEqual(binding().nativeNetlistContentIdentity);
    expect(other.identity).not.toEqual(binding().identity);
  });

  it("deeply freezes qualified values without freezing caller-owned identities", () => {
    const currentScope = { ...scope }, currentContract = { ...contract, identity: { ...contract.identity } };
    const qualified = createFreshNativeTerminalBinding(currentContract, source, currentScope);
    for (const value of [qualified, qualified.identity, qualified.contractIdentity, qualified.scopeIdentity,
      qualified.nativeNetlistContentIdentity, qualified.endpoints, ...qualified.endpoints]) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(currentScope)).toBe(false);
    expect(Object.isFrozen(currentContract.identity)).toBe(false);
    currentScope.digest = "f".repeat(64);
    currentContract.identity.digest = "e".repeat(64);
    expect(qualified.scopeIdentity).toEqual(scope);
    expect(qualified.contractIdentity).toEqual(contract.identity);
  });

  it.each([null, undefined, {}, "binding"])("rejects unauthenticated input %s", (forged) => {
    expect(() => validateCurrentFreshNativeTerminalBinding(forged, contract.identity, scope)).toThrow(/not authenticated/u);
  });

  it("rejects structurally exact serialization and spread forgeries, including from the isolation helper", () => {
    const qualified = binding();
    for (const forged of [JSON.parse(JSON.stringify(qualified)), { ...qualified }]) {
      expect(() => validateCurrentFreshNativeTerminalBinding(forged, contract.identity, scope)).toThrow(/not authenticated/u);
      expect(() => assertFreshNativeNoConnectPcbIsolation(forged as FreshNativeTerminalBinding, board())).toThrow(/not authenticated/u);
    }
  });

  it("rejects stale contract and stale scope identities", () => {
    const other = canonicalIdentity({ changed: true }, "fixture.scope.v1");
    expect(() => validateCurrentFreshNativeTerminalBinding(binding(), other, scope)).toThrow(/stale/u);
    expect(() => validateCurrentFreshNativeTerminalBinding(binding(), contract.identity, other)).toThrow(/stale/u);
  });
});

describe("qualified native NC PCB isolation", () => {
  it("accepts a singleton logical terminal and repeated physical pad members on its exact native name", () => {
    expect(() => assertFreshNativeNoConnectPcbIsolation(binding(), board())).not.toThrow();
    expect(() => assertFreshNativeNoConnectPcbIsolation(binding(), board({ firstPads: pad("2", firstName).repeat(3) }))).not.toThrow();
  });

  it.each([
    ["missing physical terminal", ""],
    ["legacy unassigned terminal", pad("2", null)],
    ["incorrect native name", pad("2", "unconnected-(J1-Pin_2-Pad2)")],
    ["one mismatched repeated member", pad("2", firstName) + pad("2", "LINK")],
    ["one unassigned repeated member", pad("2", firstName) + pad("2", null)],
  ])("rejects %s", (_label, firstPads) => {
    expect(() => assertFreshNativeNoConnectPcbIsolation(binding(), board({ firstPads }))).toThrow(/every physical pad/u);
  });

  it.each(["3", ""])("rejects another pad number '%s' sharing an NC name", (pin) => {
    expect(() => assertFreshNativeNoConnectPcbIsolation(binding(), board({ extraPads: pad(pin, firstName) }))).toThrow(/another logical terminal/u);
  });

  it.each([
    ["track", `(segment (start 1 1) (end 2 2) (width 0.25) (layer "F.Cu") (net "${firstName}"))`],
    ["via", `(via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "${firstName}"))`],
    ["zone", `(zone (net "${firstName}"))`],
    ["legacy named zone", `(zone (net_name "${firstName}"))`],
  ])("rejects %s copper on a qualified NC net", (_label, extraCopper) => {
    expect(() => assertFreshNativeNoConnectPcbIsolation(binding(), board({ extraCopper }))).toThrow(/track, via, or zone copper/u);
    expect(() => assertFreshNativeNoConnectPcbIsolation(binding(), board({ extraCopper: extraCopper.replace(firstName, "LINK") }))).not.toThrow();
  });
});

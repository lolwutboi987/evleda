import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { contentIdentity } from "../../src/core/canonical.js";
import type { FreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { verifyFreshExternalPowerSource, type FreshExternalPowerGroup } from "../../src/harness/fresh-external-power.js";
import { parseFreshBoundingBoxes, parseFreshPlacements } from "../../src/harness/kicad-tools.js";
import {
  freshPowerFlagDefinitionSemanticIdentity,
  parseFreshSchematicPowerFlagInstances,
} from "../../src/harness/fresh-kicad-parser.js";

// Source/graph fixtures are synthetic, not stock/native evidence. The explicitly
// identified captured sch_get_symbols fixture below is the only native readback.
const uuid = (value: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, "0")}`;
const rootUuid = uuid(1);
const flagUuid = uuid(2);
const flagPinUuid = uuid(3);
const connectorUuid = uuid(4);
const flagReference = "#FLG001";
const flagDefinition = `(symbol "PWR_FLAG"
  (power global)
  (in_bom no) (on_board yes)
  (property "Reference" "#FLG")
  (property "Value" "PWR_FLAG")
  (property "Footprint" "")
  (symbol "PWR_FLAG_0_1"
    (pin power_out line (at 0 0 90) (length 0)
      (name "pwr") (number "1"))))`;
const embeddedFlagDefinition = flagDefinition.replace('(symbol "PWR_FLAG"', '(symbol "power:PWR_FLAG"');
const stockSource = `(kicad_symbol_lib (version 20250114) ${flagDefinition})`;
const connectorDefinition = `(symbol "Test:Connector"
  (symbol "Connector_1_1"
    (pin passive line (at 0 0 0) (length 0) (name "1") (number "1"))))`;
const connectorInstance = `(symbol (lib_id "Test:Connector") (at 50 50 0) (unit 1)
  (uuid "${connectorUuid}") (property "Reference" "J1")
  (property "Value" "Connector") (property "Footprint" "Test:Connector"))`;
const flagInstance = `(symbol (lib_id "power:PWR_FLAG") (at 55.08 50 0) (unit 1)
  (in_bom yes) (on_board yes) (dnp no) (exclude_from_sim no)
  (uuid "${flagUuid}")
  (property "Reference" "${flagReference}")
  (property "Value" "PWR_FLAG") (property "Footprint" "")
  (property "Datasheet" "") (property "Description" "")
  (pin "1" (uuid "${flagPinUuid}"))
  (instances (project "synthetic"
    (path "/${rootUuid}" (reference "${flagReference}") (unit 1)))))`;
const schematic = (instance = flagInstance, definition = embeddedFlagDefinition) => `(kicad_sch
  (version 20250114) (uuid "${rootUuid}")
  (lib_symbols ${connectorDefinition} ${definition})
  ${connectorInstance}
  ${instance})`;
const source = schematic();
const parse = (value = source, references: readonly string[] = [flagReference]) =>
  parseFreshSchematicPowerFlagInstances(value, contentIdentity(value), references);
const definitionIdentity = (value: string, embedded: boolean) =>
  freshPowerFlagDefinitionSemanticIdentity(value, contentIdentity(value), embedded);

describe("exact external power flag definition token identity", () => {
  it("matches stock and embedded definitions after only root qualification and separator whitespace change", () => {
    const spacedEmbedded = source.replaceAll(") (", ")\n\t(");
    expect(contentIdentity(spacedEmbedded)).not.toEqual(contentIdentity(source));
    expect(definitionIdentity(spacedEmbedded, true)).toEqual(definitionIdentity(stockSource, false));
    expect(definitionIdentity(source, true)).toEqual(definitionIdentity(stockSource, false));
  });

  it.each([
    ["power scope", '(power global)', '(power local)'],
    ["electrical type", "pin power_out line", "pin power_in line"],
    ["pin length", "(length 0)", "(length 1.27)"],
    ["pin number", '(number "1")', '(number "2")'],
    ["pin name quoting", '(name "pwr")', "(name pwr)"],
    ["nested name qualification", '"PWR_FLAG_0_1"', '"power:PWR_FLAG_0_1"'],
    ["metadata", "(in_bom no)", "(in_bom yes)"],
  ])("retains %s differences in the complete definition identity", (_name, before, after) => {
    expect(definitionIdentity(stockSource.replace(before, after), false)).not.toEqual(definitionIdentity(stockSource, false));
  });

  it.each([
    ["missing stock definition", '(kicad_symbol_lib (symbol "OTHER"))', false],
    ["duplicate stock definition", `(kicad_symbol_lib ${flagDefinition} ${flagDefinition})`, false],
    ["missing embedded definition", schematic(flagInstance, ""), true],
    ["duplicate embedded definition", schematic(flagInstance, `${embeddedFlagDefinition} ${embeddedFlagDefinition}`), true],
  ] as const)("rejects %s instead of selecting a partial match", (_name, value, embedded) => {
    expect(() => definitionIdentity(value, embedded)).toThrow();
  });

  it("checks exact source identities before normalizing tokens", () => {
    expect(() => freshPowerFlagDefinitionSemanticIdentity(`${stockSource}\n`, contentIdentity(stockSource), false)).toThrow(/identity/u);
    expect(() => freshPowerFlagDefinitionSemanticIdentity(`${source}\n`, contentIdentity(source), true)).toThrow(/identity/u);
  });
});

describe("source-bound schematic-only power flag instances", () => {
  it("retains physical instances and returns the exact auxiliary instance and definition bindings", () => {
    const value = parse();
    expect(value.placed.map(component => component.reference)).toEqual(["J1", flagReference]);
    expect(value.auxiliary).toHaveLength(1);
    expect(value.auxiliary[0]).toMatchObject({
      reference: flagReference, symbolLibId: "power:PWR_FLAG", symbolUuid: flagUuid,
      unit: 1, bodyStyle: 1, sourceIdentity: contentIdentity(source),
      instanceIdentity: contentIdentity(flagInstance),
      placement: { at: { xMm: 55.08, yMm: 50 }, rotationDeg: 0 },
      pins: [{ number: "1", electricalType: "power_out", lengthMm: 0, at: { xMm: 0, yMm: 0 }, angleDeg: 90 }],
    });
    expect(value.definitionSemanticIdentity).toEqual(definitionIdentity(stockSource, false));
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.auxiliary)).toBe(true);
    expect(Object.isFrozen(value.auxiliary[0])).toBe(true);
  });

  it("supports an absent optional instance pin or one pin with a unique UUID", () => {
    expect(parse().auxiliary).toHaveLength(1);
    const withoutInstancePin = schematic(flagInstance.replace(`(pin "1" (uuid "${flagPinUuid}"))`, ""));
    expect(parse(withoutInstancePin).auxiliary[0]!.pins).toHaveLength(1);
  });

  it("retains physical-only source without inventing auxiliary geometry or a definition identity", () => {
    const physicalOnly = schematic("", "");
    const value = parse(physicalOnly, []);
    expect(value.placed.map(component => component.reference)).toEqual(["J1"]);
    expect(value.auxiliary).toEqual([]);
    expect(value).not.toHaveProperty("definitionSemanticIdentity");
  });

  it("binds instance interpretation to the exact current schematic source", () => {
    expect(() => parseFreshSchematicPowerFlagInstances(`${source}\n`, contentIdentity(source), [flagReference])).toThrow(/identity/u);
  });

  it.each([
    ["unapproved source flag", source, []],
    ["different approved reference", source, ["#FLG002"]],
    ["arbitrary hash reference", source.replaceAll(flagReference, "#PWR001"), ["#PWR001"]],
    ["short flag reference", source.replaceAll(flagReference, "#FLG01"), ["#FLG01"]],
    ["duplicate approved reference", source, [flagReference, flagReference]],
    ["excessive approved inventory", source, Array.from({ length: 17 }, (_, index) => `#FLG${String(index + 1).padStart(3, "0")}`)],
    ["changed source reference", source.replaceAll(flagReference, "#FLG002"), [flagReference]],
    ["duplicate source reference", schematic(`${flagInstance}\n${flagInstance}`), [flagReference]],
  ] as const)("rejects %s without treating hash references as physical exclusions", (_name, value, references) => {
    expect(() => parse(value, references)).toThrow();
  });

  it.each([
    ["different library", '(lib_id "power:PWR_FLAG")', '(lib_id "Test:Connector")'],
    ["changed BOM disposition", "(in_bom yes)", "(in_bom no)"],
    ["changed board disposition", "(on_board yes)", "(on_board no)"],
    ["missing BOM disposition", "(in_bom yes)", ""],
    ["duplicate board disposition", "(on_board yes)", "(on_board yes) (on_board yes)"],
    ["DNP exclusion", "(dnp no)", "(dnp yes)"],
    ["simulation exclusion", "(exclude_from_sim no)", "(exclude_from_sim yes)"],
    ["changed value", '(property "Value" "PWR_FLAG")', '(property "Value" "OTHER")'],
    ["nonempty footprint", '(property "Footprint" "")', '(property "Footprint" "Test:Physical")'],
    ["duplicate reference property", `(property "Reference" "${flagReference}")`, `(property "Reference" "${flagReference}") (property "Reference" "#FLG002")`],
    ["unsupported net property", '(property "Description" "")', '(property "Net" "VBUS")'],
    ["unsupported instance field", "(dnp no)", "(dnp no) (unexpected yes)"],
    ["missing instance UUID", `(uuid "${flagUuid}")`, ""],
    ["reused physical symbol UUID", `(uuid "${flagUuid}")`, `(uuid "${connectorUuid}")`],
    ["duplicate symbol UUID", `(uuid "${flagUuid}")`, `(uuid "${flagUuid}") (uuid "${uuid(5)}")`],
    ["wrong sheet path", `(path "/${rootUuid}"`, `(path "/${uuid(99)}"`],
    ["wrong path reference", `(reference "${flagReference}")`, '(reference "#FLG002")'],
    ["wrong path unit", `(reference "${flagReference}") (unit 1)`, `(reference "${flagReference}") (unit 2)`],
    ["missing path reference", `(reference "${flagReference}")`, ""],
    ["extra path reference", `(reference "${flagReference}")`, `(reference "${flagReference}") (reference "#FLG002")`],
    ["extra path metadata", `(reference "${flagReference}")`, `(reference "${flagReference}") (unexpected yes)`],
    ["extra instance pin", `(pin "1" (uuid "${flagPinUuid}"))`, `(pin "1" (uuid "${flagPinUuid}")) (pin "2" (uuid "${uuid(5)}"))`],
    ["wrong instance pin", '(pin "1"', '(pin "2"'],
    ["instance pin without UUID", `(pin "1" (uuid "${flagPinUuid}"))`, '(pin "1")'],
    ["reused instance pin UUID", `(uuid "${flagPinUuid}")`, `(uuid "${flagUuid}")`],
    ["duplicate instance pin UUID", `(uuid "${flagPinUuid}")`, `(uuid "${flagPinUuid}") (uuid "${uuid(5)}")`],
    ["alternate instance pin", `(pin "1" (uuid "${flagPinUuid}"))`, `(pin "1" (uuid "${flagPinUuid}") (alternate "other"))`],
  ])("rejects %s in the auxiliary instance", (_name, before, after) => {
    expect(() => parse(schematic(flagInstance.replace(before, after)))).toThrow();
  });

  it.each([
    ["quoted BOM disposition", "(in_bom yes)", '(in_bom "yes")'],
    ["quoted board disposition", "(on_board yes)", '(on_board "yes")'],
    ["malformed autoplace marker", "(dnp no)", "(dnp no) (fields_autoplaced yes)"],
  ])("rejects %s rather than accepting malformed native metadata", (_name, before, after) => {
    expect(() => parse(schematic(flagInstance.replace(before, after)))).toThrow();
  });
});

const qualifiedFlag = (reference: string, index: number, x: number, y: number) => flagInstance
  .replaceAll(flagReference, reference)
  .replace(flagUuid, uuid(10 + index * 2))
  .replace(flagPinUuid, uuid(11 + index * 2))
  .replace("(at 55.08 50 0)", `(at ${x} ${y} 0)`)
  .replace(`(property "Reference" "${reference}")`,
    `(property "Reference" "${reference}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))`)
  .replace('(property "Value" "PWR_FLAG")',
    `(property "Value" "PWR_FLAG" (at ${x} ${(y - 5.08).toFixed(2)} 0) (effects (font (size 1.27 1.27))))`)
  .replace('(property "Footprint" "")',
    `(property "Footprint" "" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))`)
  .replace('(property "Datasheet" "")',
    `(property "Datasheet" "" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))`)
  .replace('(property "Description" "")', "");
const qualifiedFlags = [
  qualifiedFlag("#FLG001", 0, 55.88, 50.8),
  qualifiedFlag("#FLG002", 1, 55.88, 76.2),
] as const;
const physicalReferences = ["J1", "J2", "J3"] as const;
const qualifiedConnectors = physicalReferences.map((reference, index) => connectorInstance
  .replace('(property "Reference" "J1")', `(property "Reference" "${reference}")`)
  .replace(connectorUuid, uuid(4 + index))
  .replace("(at 50 50 0)", `(at 50.8 ${(50.8 + index * 25.4).toFixed(2)} 0)`));
const qualifiedSchematic = (flags: readonly string[] = qualifiedFlags, definition = embeddedFlagDefinition) => `(kicad_sch
  (version 20250114) (uuid "${rootUuid}")
  (lib_symbols ${connectorDefinition} ${definition})
  ${qualifiedConnectors.join("\n")}
  ${flags.join("\n")})`;
const qualifiedSource = qualifiedSchematic();
// This helper consumes an already validated host contract. The intentional cast
// keeps these tests on source/graph verification, without fabricating native evidence.
const qualifiedContract = {
  components: physicalReferences.map(reference => ({
    reference, symbolLibId: "Test:Connector", value: "Connector", footprintLibId: "Test:Connector",
  })),
  nets: [
    { name: "SUPPLY_A", endpoints: [{ reference: "J1", pin: "1" }] },
    { name: "SUPPLY_B", endpoints: [{ reference: "J2", pin: "1" }] },
    { name: "SIGNAL", endpoints: [{ reference: "J3", pin: "1" }] },
  ],
  noConnects: [],
  externalPowerBinding: {
    source: { definitionSemanticIdentity: definitionIdentity(stockSource, false) },
    flags: [
      { reference: "#FLG001", net: "SUPPLY_A", anchorEndpoint: { reference: "J1", pin: "1" }, symbolLibId: "power:PWR_FLAG" },
      { reference: "#FLG002", net: "SUPPLY_B", anchorEndpoint: { reference: "J2", pin: "1" }, symbolLibId: "power:PWR_FLAG" },
    ],
  },
} as unknown as FreshConnectivityContract;
const nativeGroups: readonly FreshExternalPowerGroup[] = [
  { name: "SUPPLY_A", endpoints: ["#FLG001:1", "J1:1"] },
  { name: "SUPPLY_B", endpoints: ["J2:1", "#FLG002:1"] },
  { name: "SIGNAL", endpoints: ["J3:1"] },
];
const physicalGroups = [
  { name: "SUPPLY_A", endpoints: ["J1:1"] },
  { name: "SUPPLY_B", endpoints: ["J2:1"] },
  { name: "SIGNAL", endpoints: ["J3:1"] },
];
const qualifiedPlacements = [
  { reference: "#FLG001", x: 55.88, y: 50.8, rotation: 0 },
  { reference: "#FLG002", x: 55.88, y: 76.2, rotation: 0 },
] as const;

describe("qualified external power source and complete native graph projection", () => {
  it("projects exactly the verified flag pins and retains every physical symbol and other group", () => {
    const graphBefore = JSON.stringify(nativeGroups);
    const value = verifyFreshExternalPowerSource(qualifiedContract, qualifiedSource, {
      groups: nativeGroups, placements: qualifiedPlacements,
    });
    expect(value.references).toEqual(["#FLG001", "#FLG002"]);
    expect(value.sourcePlacements).toEqual(qualifiedPlacements.map(placement => ({ ...placement,
      library: "power", symbol: "PWR_FLAG", value: "PWR_FLAG", unit: 1, sourceIdentity: contentIdentity(qualifiedSource),
    })));
    expect(Object.isFrozen(value.sourcePlacements)).toBe(true);
    expect(value.sourcePlacements.every(Object.isFrozen)).toBe(true);
    expect(value.physicalSymbols).toEqual(physicalReferences.map(reference => ({
      reference, libId: "Test:Connector", value: "Connector", footprint: "Test:Connector",
    })));
    expect(value.groups).toEqual(physicalGroups);
    expect(value.groups?.[2]).toEqual(nativeGroups[2]);
    expect(JSON.stringify(nativeGroups)).toBe(graphBefore);
    expect(Object.isFrozen(value.references)).toBe(true);
    expect(Object.isFrozen(value.groups)).toBe(true);
    expect(value.groups?.every(group => Object.isFrozen(group) && Object.isFrozen(group.endpoints))).toBe(true);
  });

  const invalidGroups: readonly { label: string; groups: readonly FreshExternalPowerGroup[] }[] = [
    { label: "a flag group with the wrong native net name", groups: [
      { name: "WRONG", endpoints: ["J1:1", "#FLG001:1"] }, nativeGroups[1]!, nativeGroups[2]!,
    ] },
    { label: "a flag attached to the other physical net", groups: [
      { name: "SUPPLY_A", endpoints: ["J1:1", "#FLG002:1"] },
      { name: "SUPPLY_B", endpoints: ["J2:1", "#FLG001:1"] }, nativeGroups[2]!,
    ] },
    { label: "a disconnected flag in a separate group", groups: [
      { name: "SUPPLY_A", endpoints: ["J1:1"] },
      { name: "unconnected", endpoints: ["#FLG001:1"] }, nativeGroups[1]!, nativeGroups[2]!,
    ] },
    { label: "a flag missing from native readback", groups: [physicalGroups[0]!, nativeGroups[1]!, nativeGroups[2]!] },
    { label: "a duplicated flag endpoint within one group", groups: [
      { name: "SUPPLY_A", endpoints: ["J1:1", "#FLG001:1", "#FLG001:1"] }, nativeGroups[1]!, nativeGroups[2]!,
    ] },
    { label: "a flag endpoint repeated across groups", groups: [
      ...nativeGroups, { name: "DUPLICATE", endpoints: ["#FLG001:1"] },
    ] },
    { label: "an extra flag pin on its declared net", groups: [
      { name: "SUPPLY_A", endpoints: ["J1:1", "#FLG001:1", "#FLG001:2"] }, nativeGroups[1]!, nativeGroups[2]!,
    ] },
    { label: "a physical endpoint from another net on the flag group", groups: [
      { name: "SUPPLY_A", endpoints: ["J1:1", "J3:1", "#FLG001:1"] }, nativeGroups[1]!,
    ] },
    { label: "an unknown hash reference on the flag group", groups: [
      { name: "SUPPLY_A", endpoints: ["J1:1", "#FLG001:1", "#PWR999:1"] }, nativeGroups[1]!, nativeGroups[2]!,
    ] },
    { label: "an extra flag pin on an unrelated group", groups: [
      nativeGroups[0]!, nativeGroups[1]!, { name: "SIGNAL", endpoints: ["J3:1", "#FLG001:2"] },
    ] },
    { label: "an unknown hash reference in an unrelated group", groups: [
      ...nativeGroups, { name: "UNKNOWN", endpoints: ["#PWR999:1"] },
    ] },
  ];
  it.each(invalidGroups)("rejects $label before excluding auxiliary endpoints", ({ groups }) => {
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, qualifiedSource, { groups })).toThrow();
  });

  it("rejects an unknown hash reference even when it imitates a valid flag instance", () => {
    const unknown = qualifiedFlag("#FLG999", 2, 55.88, 101.6);
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, qualifiedSchematic([...qualifiedFlags, unknown]), {
      groups: nativeGroups,
    })).toThrow();
  });

  it("rejects stock definition drift before granting a physical-symbol projection", () => {
    const changedSource = qualifiedSchematic(qualifiedFlags, embeddedFlagDefinition.replace("(power global)", "(power local)"));
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, changedSource, { groups: nativeGroups })).toThrow(/definition/u);
  });

  it.each([
    ["different collision-checked coordinates", [{ ...qualifiedPlacements[0], x: 57.15 }, qualifiedPlacements[1]]],
    ["missing collision-checked placement", [qualifiedPlacements[0]]],
  ] as const)("rejects %s", (_label, placements) => {
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, qualifiedSource, { groups: nativeGroups, placements })).toThrow(/placement/u);
  });

  it.each([
    ["visible reference", "(hide yes)", "(hide no)"],
    ["wrong value field position", "(at 55.88 45.72 0)", "(at 55.88 44.45 0)"],
    ["wrong value field rotation", "(at 55.88 45.72 0)", "(at 55.88 45.72 90)"],
    ["off-grid flag anchor", "(at 55.88 50.8 0)", "(at 55.89 50.8 0)"],
    ["unsupported flag rotation", "(at 55.88 50.8 0)", "(at 55.88 50.8 90)"],
  ])("rejects a %s in otherwise complete qualified source", (_label, before, after) => {
    const changedSource = qualifiedSchematic([qualifiedFlags[0].replace(before, after), qualifiedFlags[1]]);
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, changedSource, { groups: nativeGroups })).toThrow();
  });

  const valueField = '(property "Value" "PWR_FLAG" (at 55.88 45.72 0) (effects (font (size 1.27 1.27))))';
  const datasheetField = '(property "Datasheet" "" (at 55.88 50.8 0) (effects (font (size 1.27 1.27)) (hide yes)))';
  it.each([
    ["left-justified value", valueField, valueField.replace('(font (size 1.27 1.27))', '(font (size 1.27 1.27)) (justify left)')],
    ["bold value", valueField, valueField.replace('(font (size 1.27 1.27))', '(font (size 1.27 1.27) bold)')],
    ["italic value", valueField, valueField.replace('(font (size 1.27 1.27))', '(font (size 1.27 1.27) italic)')],
    ["visible datasheet", datasheetField, datasheetField.replace('(hide yes)', '(hide no)')],
    ["visible description", datasheetField, `${datasheetField} (property "Description" "Unreserved text" (at 55.88 50.8 0) (effects (font (size 1.27 1.27))))`],
  ])("rejects a %s outside the reserved writer field inventory", (_label, before, after) => {
    const changedSource = qualifiedSchematic([qualifiedFlags[0].replace(before, after), qualifiedFlags[1]]);
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, changedSource, { groups: nativeGroups })).toThrow();
  });

  it("does not ignore a hash reference when the contract has no external power binding", () => {
    const { externalPowerBinding, ...withoutBinding } = qualifiedContract;
    expect(externalPowerBinding).toBeDefined();
    expect(() => verifyFreshExternalPowerSource(withoutBinding, qualifiedSource, { groups: nativeGroups, allowAbsent: true })).toThrow(/Unexpected schematic symbol/u);
    const physicalOnly = qualifiedSchematic([], "");
    expect(verifyFreshExternalPowerSource(withoutBinding, physicalOnly, { groups: physicalGroups }).groups).toEqual(physicalGroups);
  });

  it("allows a wholly absent flag inventory only when allowAbsent is explicit", () => {
    const physicalOnly = qualifiedSchematic([], "");
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, physicalOnly)).toThrow(/inventory/u);
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, physicalOnly, { allowAbsent: false })).toThrow(/inventory/u);
    const value = verifyFreshExternalPowerSource(qualifiedContract, physicalOnly, { allowAbsent: true, groups: physicalGroups });
    expect(value.references).toEqual([]);
    expect(value.sourcePlacements).toEqual([]);
    expect(value.physicalSymbols.map(symbol => symbol.reference)).toEqual(physicalReferences);
    expect(value.groups).toEqual(physicalGroups);
  });

  it.each([
    ["wire", '(wire (pts (xy 50.8 50.8) (xy 55.88 50.8)))'],
    ["label", '(label "SUPPLY_A" (at 55.88 50.8 0))'],
    ["junction", '(junction (at 55.88 50.8))'],
    ["no-connect", '(no_connect (at 50.8 50.8))'],
  ])("rejects an absent flag inventory with an existing %s even when allowAbsent is true", (_kind, primitive) => {
    const nonPristine = qualifiedSchematic([], "").replace(/\)$/u, ` ${primitive})`);
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, nonPristine, { allowAbsent: true, groups: physicalGroups })).toThrow();
  });

  it.each([false, true])("rejects a partial source flag inventory with allowAbsent=%s", allowAbsent => {
    const partial = qualifiedSchematic([qualifiedFlags[0]]);
    expect(() => verifyFreshExternalPowerSource(qualifiedContract, partial, { allowAbsent })).toThrow(/inventory/u);
  });
});

describe("source-qualified DOC7 power symbol readback", () => {
  const physicalRow = "- J1 Connector Test:Connector @ (50.80, 50.80) rot=0 unit=1 footprint=Test:Connector";
  const powerRows = ["- #FLG001 PWR_FLAG @ (55.88, 50.80) unit=1", "- #FLG002 PWR_FLAG @ (55.88, 76.20) unit=1"];
  const readback = ["Symbols (3 total):", physicalRow, "Power symbols:", ...powerRows].join("\n");
  const qualified = () => verifyFreshExternalPowerSource(qualifiedContract, qualifiedSource, { groups: nativeGroups });

  it("compares every reported field and marks omitted fields as saved-source facts", () => {
    const values = parseFreshPlacements(readback, qualified().sourcePlacements);
    expect(values.get("J1")?.[0]).not.toHaveProperty("sourceBoundFields");
    expect(values.get("#FLG001")).toEqual([{
      reference: "#FLG001", value: "PWR_FLAG", x: 55.88, y: 50.8, unit: 1,
      library: "power", symbol: "PWR_FLAG", rotation: 0,
      sourceBoundFields: { basis: "verified-schematic-source", sourceIdentity: contentIdentity(qualifiedSource),
        fields: ["library", "symbol", "rotation", "footprint"] },
    }]);
    expect([...values.keys()]).toEqual(["J1", "#FLG001", "#FLG002"]);
  });

  it("parses unchanged captured USB-C native02 output with separately qualified synthetic auxiliary source facts", async () => {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/fresh-project/captured-usb-c-power-symbols.report.json", import.meta.url), "utf8")) as {
      provenance: { kind: string; contentIdentity: ReturnType<typeof contentIdentity> }; content: string;
    };
    expect(fixture.provenance.kind).toBe("captured-native-public-response");
    expect(contentIdentity(fixture.content)).toEqual(fixture.provenance.contentIdentity);
    // Matching auxiliary source/graph data is deliberately synthetic. This test
    // replays captured formatting; it does not certify the native02 schematic.
    const syntheticSource = qualifiedSchematic([
      qualifiedFlag("#FLG001", 0, 134.62, 88.9), qualifiedFlag("#FLG002", 1, 134.62, 55.88),
    ]).replaceAll("(at 50.8", "(at 129.54");
    const facts = verifyFreshExternalPowerSource(qualifiedContract, syntheticSource, { groups: nativeGroups }).sourcePlacements;
    const text = (JSON.parse(fixture.content) as { result: string }).result;
    const values = parseFreshPlacements(text, facts);
    expect([...values.keys()]).toEqual(["J1", "J2", "#FLG001", "#FLG002"]);
    expect(values.get("J1")?.[0]).toMatchObject({ library: "Connector", symbol: "USB_C_Receptacle_USB2.0_16P", rotation: 0, unit: 1 });
    expect(values.get("#FLG001")?.[0]).toMatchObject({ x: 134.62, y: 88.9, sourceBoundFields: { sourceIdentity: contentIdentity(syntheticSource) } });
    expect(values.get("#FLG002")?.[0]).toMatchObject({ x: 134.62, y: 55.88 });
  });

  it("preserves legacy complete rows without adding source-derived metadata", () => {
    const rows = qualifiedPlacements.map(value => `- ${value.reference} PWR_FLAG power:PWR_FLAG @ (${value.x.toFixed(2)}, ${value.y.toFixed(2)}) rot=0 unit=1`);
    const values = parseFreshPlacements(["Symbols (3 total):", physicalRow, ...rows].join("\n"), qualified().sourcePlacements);
    expect(values.get("#FLG001")).toEqual([{ reference: "#FLG001", value: "PWR_FLAG", library: "power", symbol: "PWR_FLAG", x: 55.88, y: 50.8, rotation: 0, unit: 1 }]);
    for (const [before, after] of [["rot=0", "rot=90"], ["power:PWR_FLAG", "other:PWR_FLAG"], ["unit=1", "unit=2"], ["55.88", "57.15"]]) {
      const changed = ["Symbols (3 total):", physicalRow, rows[0]!.replace(before!, after!), rows[1]!].join("\n");
      expect(() => parseFreshPlacements(changed, qualified().sourcePlacements)).toThrow(/verified source/u);
    }
  });

  it.each([
    ["unknown auxiliary", readback.replace("#FLG002", "#FLG999")],
    ["duplicate auxiliary", readback.replace("#FLG002", "#FLG001")],
    ["missing auxiliary with adjusted count", readback.replace("(3 total)", "(2 total)").replace(`\n${powerRows[1]}`, "")],
    ["declared count drift", readback.replace("(3 total)", "(4 total)")],
    ["physical-only declared count", readback.replace("(3 total)", "(1 total)")],
    ["changed x", readback.replace("(55.88, 50.80)", "(57.15, 50.80)")],
    ["changed y", readback.replace("(55.88, 50.80)", "(55.88, 52.07)")],
    ["changed value", readback.replace("#FLG001 PWR_FLAG", "#FLG001 OTHER")],
    ["changed unit", readback.replace(`${powerRows[0]}`, `${powerRows[0]!.replace("unit=1", "unit=2")}`)],
    ["unsupported rotation suffix", `${readback} rot=90`],
    ["unsupported footprint suffix", `${readback} footprint=Test:Physical`],
    ["malformed power heading", readback.replace("Power symbols:", "Power symbols (2):")],
    ["repeated power heading", readback.replace("Power symbols:", "Power symbols:\nPower symbols:")],
    ["missing total heading", readback.replace("Symbols (3 total):\n", "")],
    ["missing power heading", readback.replace("Power symbols:\n", "")],
    ["empty power section", `Symbols (1 total):\n${physicalRow}\nPower symbols:`],
    ["physical row inside power section", `Symbols (3 total):\nPower symbols:\n${physicalRow}\n${powerRows.join("\n")}`],
    ["full auxiliary outside power section", `Symbols (3 total):\n- #FLG001 PWR_FLAG power:PWR_FLAG @ (55.88, 50.80) rot=0 unit=1\nPower symbols:\n${powerRows.join("\n")}`],
    ["nonfinite coordinate", readback.replace("55.88", "NaN")],
    ["out-of-bounds coordinate", readback.replace("55.88", "2001.00")],
  ])("rejects synthetic %s readback", (_label, text) => {
    expect(() => parseFreshPlacements(text, qualified().sourcePlacements)).toThrow();
  });

  it("rejects unbound power rows and duplicated source facts", () => {
    expect(() => parseFreshPlacements(readback)).toThrow(/unbound auxiliary/u);
    const facts = qualified().sourcePlacements;
    expect(() => parseFreshPlacements(readback, [facts[0]!, facts[0]!])).toThrow(/duplicate auxiliary/u);
  });

  it("cannot derive omitted rotation from a modified or unsupported source", () => {
    const changedSource = qualifiedSource.replace("(at 55.88 50.8 0)", "(at 55.88 50.8 90)");
    expect(() => parseFreshPlacements(readback, verifyFreshExternalPowerSource(qualifiedContract, changedSource, { groups: nativeGroups }).sourcePlacements)).toThrow(/geometry or placement/u);
  });

  it("accepts the DOC7 combined bounding-box table including every auxiliary row", () => {
    // Synthetic producer-shaped rows, not a captured post-flag bounds response.
    // DOC7 uses one physical + power table and seeds positive default extents.
    const boxes = ["Schematic bounding boxes (3 symbols):", "Ref Value X Y X_min Y_min X_max Y_max", "-".repeat(76),
      "J1 Connector 50.80 50.80 40.64 43.18 60.96 58.42",
      "#FLG001 PWR_FLAG 55.88 50.80 45.72 43.18 66.04 58.42",
      "#FLG002 PWR_FLAG 55.88 76.20 45.72 68.58 66.04 83.82", "",
      "Sheet occupied region: X=[40.6, 66.0] Y=[43.2, 83.8] mm", "Tip: use sch_find_free_placement to get safe coordinates for new symbols."].join("\n");
    expect(parseFreshBoundingBoxes(boxes).map(value => value.reference)).toEqual(["J1", "#FLG001", "#FLG002"]);
    expect(() => parseFreshBoundingBoxes(boxes.replace("(3 symbols)", "(1 symbols)"))).toThrow(/count mismatch/u);
    expect(() => parseFreshBoundingBoxes(boxes.replace("#FLG002 PWR_FLAG 55.88 76.20 45.72 68.58 66.04 83.82\n", ""))).toThrow(/count mismatch/u);
  });
});

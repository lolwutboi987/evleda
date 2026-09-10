import { describe, expect, it } from "vitest";
import { freshGlobalLabelInventoryMatches, freshSchematicClassSourcesSupported, parseFreshSchematicSource } from "../../src/harness/fresh-kicad-parser.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { freshNativeNetlistParityIssues } from "../../src/harness/kicad-tools.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

describe("bounded schematic label and sheet facts", () => {
  it("preserves local, global and hierarchical label kinds and exact shapes", () => {
    const parsed = parseFreshSchematicSource(`(kicad_sch
      (label "LOCAL" (at 1.27 2.54 0))
      (global_label "GLOBAL" (shape passive) (at 3.81 5.08 0))
      (hierarchical_label "PORT" (shape input) (at 6.35 7.62 0)))`);
    expect(parsed.labels).toEqual([
      { name: "LOCAL", kind: "local", shape: null, at: { x: 1.27, y: 2.54 } },
      { name: "GLOBAL", kind: "global", shape: "passive", at: { x: 3.81, y: 5.08 } },
      { name: "PORT", kind: "hierarchical", shape: "input", at: { x: 6.35, y: 7.62 } },
    ]);
  });

  it("counts only actual root child sheets, not nested metadata or text", () => {
    expect(parseFreshSchematicSource('(kicad_sch (sheet_instances (path "/" (page "1"))) (text "(sheet)" (at 0 0)))').childSheetCount).toBe(0);
    expect(parseFreshSchematicSource('(kicad_sch (sheet (property "Sheetfile" "child.kicad_sch")) (sheet))').childSheetCount).toBe(2);
  });

  it.each([
    '(global_label "VIN" (at 1 2 0))',
    '(global_label "VIN" (shape passive) (shape input) (at 1 2 0))',
    '(hierarchical_label "VIN" (shape) (at 1 2 0))',
    '(label "VIN" (shape passive) (at 1 2 0))',
  ])("refuses malformed label shape facts: %s", (form) => {
    expect(() => parseFreshSchematicSource(`(kicad_sch ${form})`)).toThrow(/shape/iu);
  });

  it("requires one passive global of each exact name and rejects duplicate expected names", () => {
    const parsed = parseFreshSchematicSource('(kicad_sch (global_label "VIN" (shape passive) (at 1 2 0)))');
    expect(freshGlobalLabelInventoryMatches(parsed, ["VIN"])).toBe(true);
    expect(freshGlobalLabelInventoryMatches(parsed, ["/VIN"])).toBe(false);
    expect(freshGlobalLabelInventoryMatches(parsed, ["VIN", "VIN"])).toBe(false);
  });
});

describe("native flat name parity", () => {
  const contract = createFreshConnectivityContract(createGenericDividerBundleFixture().bundle.contract);
  const native = (prefix: string) => `(export (components ${contract.components.map((component) => {
    const [library, part] = component.symbolLibId.split(":");
    return `(comp (ref "${component.reference}") (value "${component.value}") (footprint "${component.footprintLibId}") (libsource (lib "${library}") (part "${part}")))`;
  }).join(" ")}) (nets ${contract.nets.map((net) => `(net (name "${prefix}${net.name}") ${net.endpoints.map((endpoint) => `(node (ref "${endpoint.reference}") (pin "${endpoint.pin}") (pintype "passive"))`).join(" ")})`).join(" ")}))`;

  it("accepts bare contract names with exact endpoint sets", () => {
    expect(freshNativeNetlistParityIssues(contract, native(""))).toEqual([]);
  });

  it.each(["/", "/child/"])("rejects native scope prefix %s without stripping aliases", (prefix) => {
    expect(freshNativeNetlistParityIssues(contract, native(prefix))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NATIVE_NET_NAME_PARITY_MISMATCH" }),
      expect.objectContaining({ code: "NATIVE_NET_ENDPOINT_PARITY_MISMATCH" }),
    ]));
  });
});

describe("generic authored-pattern schematic source model", () => {
  const global = (fields: string) => `(kicad_sch (global_label "VIN" (shape passive) (at 1.27 2.54 0) ${fields}))`;

  it.each([
    '(property "Netclass" "OtherClass" (at 1.27 2.54 0))',
    '(property private "Netclass" "OtherClass" (at 1.27 2.54 0))',
    '(property "Net Class" "OtherClass" (at 1.27 2.54 0))',
    '(property private "Net Class" "" (at 1.27 2.54 0))',
  ])("accounts for native Netclass fields, including private/empty forms: %s", (field) => {
    const parsed = parseFreshSchematicSource(global(field));
    expect(parsed.classSources).toMatchObject({ netclassPropertyCount: 1 });
    expect(freshSchematicClassSourcesSupported(parsed)).toBe(false);
    expect(freshGlobalLabelInventoryMatches(parsed, ["VIN"])).toBe(false);
  });

  it.each(["netclass", "Netzklasse", "Description", "private"])("rejects unsupported global user-field metadata without guessing locale aliases: %s", (name) => {
    const parsed = parseFreshSchematicSource(global(`(property "${name}" "OtherClass" (at 1.27 2.54 0))`));
    expect(parsed.classSources).toMatchObject({ netclassPropertyCount: 0, unsupportedLabelPropertyCount: 1 });
    expect(freshSchematicClassSourcesSupported(parsed)).toBe(false);
  });

  it.each(["label", "global_label", "hierarchical_label"])("detects canonical private Netclass fields on native %s forms without changing their parsed kind", (kind) => {
    const parsed = parseFreshSchematicSource(`(kicad_sch (${kind} "VIN" ${kind === "label" ? "" : "(shape passive)"} (at 1.27 2.54 0) (property private "Netclass" "OtherClass")))`);
    expect(parsed.classSources.netclassPropertyCount).toBe(1);
    expect(parsed.labels).toHaveLength(1);
    expect(freshSchematicClassSourcesSupported(parsed)).toBe(false);
  });

  it.each(["Intersheetrefs", "INTERSHEETREFS", "Intersheet References", "intersheet references"])("preserves native case-insensitive global intersheet field spelling %s", (name) => {
    const parsed = parseFreshSchematicSource(global(`(fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid "00000000-0000-4000-8000-000000000001") (property private "${name}" "\${INTERSHEET_REFS}" (at 1.27 2.54 0) (hide yes)) (iref (at 1.27 2.54))`));
    expect(freshSchematicClassSourcesSupported(parsed)).toBe(true);
    expect(freshGlobalLabelInventoryMatches(parsed, ["VIN"])).toBe(true);
  });

  it("does not mistake an intersheet-like field on a local label for a native global field", () => {
    const parsed = parseFreshSchematicSource('(kicad_sch (label "VIN" (at 1.27 2.54 0) (property "Intersheetrefs" "OtherClass")))');
    expect(parsed.labels[0]).toMatchObject({ name: "VIN", kind: "local", shape: null });
    expect(parsed.classSources.unsupportedLabelPropertyCount).toBe(1);
  });

  it.each(["directive_label", "netclass_flag"])("accounts for the accepted native directive form %s", (kind) => {
    const parsed = parseFreshSchematicSource(`(kicad_sch (${kind} "" (at 1.27 2.54 0) (length 2.54) (shape dot) (property "Netclass" "OtherClass")))`);
    expect(parsed.classSources).toMatchObject({ directiveLabelCount: 1, netclassPropertyCount: 1 });
    expect(freshSchematicClassSourcesSupported(parsed)).toBe(false);
  });

  it("rejects the actual native rule_area wrapper while preserving ordinary drawings and quoted lookalikes", () => {
    const polyline = '(polyline (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 0)) (stroke (width 0.15) (type default)) (fill (type none)) (uuid "00000000-0000-4000-8000-000000000002"))';
    const ordinary = parseFreshSchematicSource(`(kicad_sch ${polyline} (rectangle (start 0 0) (end 10 10)) (text "rule_area Netclass directive_label" (at 0 0)))`);
    expect(freshSchematicClassSourcesSupported(ordinary)).toBe(true);
    const area = parseFreshSchematicSource(`(kicad_sch (rule_area (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) ${polyline}))`);
    expect(area.classSources.ruleAreaCount).toBe(1);
    expect(freshSchematicClassSourcesSupported(area)).toBe(false);
  });
});

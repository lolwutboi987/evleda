import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildReferenceSystemArchitecture } from "../../src/generators/system-architecture-generator.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  referenceControllerRevASourceBinding
} from "../../src/knowledge/reference-controller-native-contract.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import { CURRENT_SYSTEM_ARCHITECTURE_SCHEMA } from "../../src/knowledge/reference-system-architecture.js";
import {
  CURRENT_SCHEMATIC_INTENT_SCHEMA,
  buildReferenceSchematicIntent
} from "../../src/knowledge/reference-schematic-intent.js";

const unescapeKicadString = (value: string): string => value.replace(/\\([\\"])/gu, "$1");

const sExpressionForms = (source: string, name: string): readonly string[] => {
  const forms: string[] = [];
  const marker = `(${name}`;
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    const boundary = source[start + marker.length];
    if (boundary !== undefined && !/[\s)]/u.test(boundary)) {
      cursor = start + marker.length;
      continue;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) throw new Error(`unterminated ${name}`);
    forms.push(source.slice(start, end));
    cursor = end;
  }
  return forms;
};

const stringField = (form: string, field: string): string | null => {
  const match = new RegExp(`\\(${field}\\s+"((?:\\\\.|[^"\\\\])*)"\\)`, "u").exec(form);
  return match?.[1] === undefined ? null : unescapeKicadString(match[1]);
};

const parseCsv = (source: string): readonly Readonly<Record<string, string>>[] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  if (header === undefined) throw new Error("BOM is empty");
  return rows
    .filter((values) => values.some((value) => value.length > 0))
    .map((values) =>
      Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""]))
    );
};

const scaledValue = (
  value: string,
  scales: Readonly<Record<string, number>>
): number => {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmunp]?)/iu.exec(value);
  if (match?.[1] === undefined) throw new Error(`No numeric prefix in ${value}`);
  const scale = scales[(match[2] ?? "").toLowerCase()] ?? 1;
  return Number(match[1]) * scale;
};

const ohms = (value: string): number => scaledValue(value, { k: 1_000, m: 1_000_000 });
const nanofarads = (value: string): number =>
  scaledValue(value, { p: 0.001, n: 1, u: 1_000 });

const pinnedText = (role: Parameters<typeof referenceControllerRevASourceBinding>[0]): string =>
  readFileSync(referenceControllerRevASourceBinding(role).path, "utf8");

interface NativeNode {
  readonly reference: string;
  readonly pin: string;
}

const nativeModel = () => {
  const netlist = pinnedText("schematic_netlist");
  const bomRows = parseCsv(pinnedText("exported_bom"));
  const components = new Map(
    sExpressionForms(netlist, "comp").map((form) => {
      const reference = stringField(form, "ref");
      if (reference === null) throw new Error("component lacks reference");
      return [reference, {
        value: stringField(form, "value") ?? "",
        footprint: stringField(form, "footprint") ?? "",
        part: stringField(form, "part") ?? ""
      }] as const;
    })
  );
  const nodesByNet = new Map<string, NativeNode[]>();
  const netByNode = new Map<string, string>();
  for (const netForm of sExpressionForms(netlist, "net")) {
    const name = stringField(netForm, "name");
    if (name === null) throw new Error("net lacks name");
    const nodes = sExpressionForms(netForm, "node").map((nodeForm) => {
      const reference = stringField(nodeForm, "ref");
      const pin = stringField(nodeForm, "pin");
      if (reference === null || pin === null) throw new Error("node lacks endpoint");
      netByNode.set(`${reference}.${pin}`, name);
      return { reference, pin };
    });
    nodesByNet.set(name, nodes);
  }
  return { bomRows, components, nodesByNet, netByNode };
};

const otherNet = (
  reference: string,
  pin: string,
  netByNode: ReadonlyMap<string, string>
): string | undefined => netByNode.get(`${reference}.${pin === "1" ? "2" : "1"}`);

describe("source-backed Rev-A semantic generators", () => {
  it("renders the exact contract vocabulary and actual flat native structure", () => {
    const intent = buildReferenceSchematicIntent(
      ROBOTICS_CONTROLLER_V0,
      "a".repeat(64),
      "revision_native_semantics"
    );
    const architecture = buildReferenceSystemArchitecture(ROBOTICS_CONTROLLER_V0);
    const nativeNets = new Set(nativeModel().nodesByNet.keys());

    expect(intent.schemaVersion).toBe(CURRENT_SCHEMATIC_INTENT_SCHEMA);
    expect(architecture.schemaVersion).toBe(CURRENT_SYSTEM_ARCHITECTURE_SCHEMA);
    expect(intent.requiredNetBindings.map((binding) => binding.semanticName)).toEqual(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.schematicIntentRequiredSemanticNets
    );
    for (const binding of intent.requiredNetBindings) {
      expect(binding.nativeNetNames).toEqual(
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases[
          binding.semanticName
        ]
      );
      expect(binding.nativeNetNames.every((name) => nativeNets.has(name))).toBe(true);
    }
    expect(intent.requiredNets).toEqual(
      intent.requiredNetBindings.flatMap((binding) => binding.nativeNetNames)
    );

    const expectedArchitectureBindings = Object.keys(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases
    ).sort();
    expect(architecture.nativeNetBindings.architecture.map((entry) => entry.semanticName))
      .toEqual(expectedArchitectureBindings);
    for (const entry of architecture.nativeNetBindings.architecture) {
      expect(entry.nativeNetNames).toEqual(
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases[
          entry.semanticName
        ]
      );
    }

    const nativeSchematic = pinnedText("native_schematic");
    expect(sExpressionForms(nativeSchematic, "sheet")).toHaveLength(0);
    expect(sExpressionForms(nativeSchematic, "sheet_instances")).toHaveLength(1);
    expect(intent.schematicStructure).toEqual({
      representation: "flat_root",
      rootSheetId: "root",
      nativeSheetCount: 1,
      functionalGroupsAreSheets: false
    });
    expect(intent.functionalGroups.every((group) => group.nativeSheet === "root")).toBe(true);
    expect(intent).not.toHaveProperty("hierarchicalSheets");
  });

  it("matches VREF, CAN termination, PTC, test-point, rail-load, and reset networks in pinned native sources", () => {
    const intent = buildReferenceSchematicIntent(
      ROBOTICS_CONTROLLER_V0,
      "b".repeat(64),
      "revision_native_circuits"
    );
    const architecture = buildReferenceSystemArchitecture(ROBOTICS_CONTROLLER_V0);
    const { bomRows, components, nodesByNet, netByNode } = nativeModel();
    const bomByReference = new Map(bomRows.map((row) => [row.Reference!, row]));

    const vrefNetworks = [...nodesByNet.entries()]
      .filter(([name]) => /^M[0-9]+_VREF$/u.test(name))
      .map(([, nodes]) => {
        const resistors = nodes.filter((node) => node.reference.startsWith("R"));
        const capacitor = nodes.find((node) => node.reference.startsWith("C"));
        const top = resistors.find(
          (node) => otherNet(node.reference, node.pin, netByNode) === "+3V3"
        );
        const bottom = resistors.find(
          (node) => otherNet(node.reference, node.pin, netByNode) === "GND"
        );
        if (top === undefined || bottom === undefined || capacitor === undefined) {
          throw new Error("incomplete native VREF network");
        }
        return {
          topOhm: ohms(components.get(top.reference)!.value),
          bottomOhm: ohms(components.get(bottom.reference)!.value),
          filterCapacitanceNf: nanofarads(components.get(capacitor.reference)!.value)
        };
      });
    expect(vrefNetworks).toHaveLength(ROBOTICS_CONTROLLER_V0.motor.channels);
    for (const network of vrefNetworks) {
      expect(network).toEqual({
        topOhm: intent.motorCurrentRegulation.vrefDivider.topOhm,
        bottomOhm: intent.motorCurrentRegulation.vrefDivider.bottomOhm,
        filterCapacitanceNf:
          intent.motorCurrentRegulation.vrefDivider.filterCapacitanceNf
      });
    }
    const divider = intent.motorCurrentRegulation.vrefDivider;
    expect(intent.motorCurrentRegulation.vrefTargetMv).toBe(
      Math.round(
        (divider.sourceMv * divider.bottomOhm * 100) /
          (divider.topOhm + divider.bottomOhm)
      ) / 100
    );

    const terminationNodes = nodesByNet.get("CAN_TERM") ?? [];
    const terminationResistor = terminationNodes.find((node) =>
      node.reference.startsWith("R")
    );
    const terminationJumper = terminationNodes.find((node) =>
      node.reference.startsWith("JP")
    );
    if (terminationResistor === undefined || terminationJumper === undefined) {
      throw new Error("CAN termination network is incomplete");
    }
    expect(intent.canTermination).toMatchObject({
      resistanceOhm: ohms(components.get(terminationResistor.reference)!.value),
      resistorReference: terminationResistor.reference,
      resistorPopulation:
        bomByReference.get(terminationResistor.reference)?.DNP === "" ? "fitted" : "dnp",
      enableJumperReference: terminationJumper.reference,
      enableJumperImplementation: components.get(terminationJumper.reference)!.part.includes("Open")
        ? "normally_open_solder_jumper"
        : "closed_jumper",
      defaultState: "open_disabled"
    });
    const canInterface = architecture.interfaces.find((entry) => entry.name === "CAN")!;
    expect(canInterface.electrical).toContain(terminationJumper.reference);
    expect(canInterface.electrical).toContain("normally-open");
    expect(JSON.stringify(architecture)).not.toMatch(/\bDNP\b/u);

    const overcurrent = bomRows.find((row) =>
      /input overcurrent protection/iu.test(row.Purpose ?? "")
    );
    if (overcurrent === undefined) throw new Error("input protection missing from BOM");
    expect(intent.nativeImplementation.inputOvercurrentProtection).toEqual({
      reference: overcurrent.Reference,
      implementation: /PTC/iu.test(overcurrent.Value ?? "")
        ? "surface_mount_resettable_ptc"
        : "other",
      value: overcurrent.Value,
      footprint: overcurrent.Footprint
    });
    const testPoints = bomRows
      .filter((row) => /^TP[0-9]+$/u.test(row.Reference ?? "") || /TestPoint/iu.test(row.Footprint ?? ""))
      .map((row) => row.Reference!);
    expect(intent.nativeImplementation.testPointDesignators).toEqual(testPoints);
    expect(architecture.powerRails.every((rail) => rail.testPointDesignators.length === 0)).toBe(true);

    const fiveVoltIcLoads = [
      ...new Set((nodesByNet.get("+5V") ?? [])
        .map((node) => node.reference)
        .filter((reference) => reference.startsWith("U")))
    ].sort();
    const fiveVoltRail = architecture.powerRails.find((rail) => rail.semanticName === "5V0")!;
    expect([...fiveVoltRail.functionalLoadDesignators].sort()).toEqual(fiveVoltIcLoads);
    expect(fiveVoltRail.consumers.join(" ")).not.toMatch(/status|expansion/iu);
    const fiveVoltReferences = new Set((nodesByNet.get("+5V") ?? []).map((node) => node.reference));
    const threeVoltReferences = new Set((nodesByNet.get("+3V3") ?? []).map((node) => node.reference));
    const statusOrExpansionReferences = bomRows
      .filter((row) => /indicator|header/iu.test(row.Purpose ?? ""))
      .map((row) => row.Reference!);
    expect(statusOrExpansionReferences.some((reference) => threeVoltReferences.has(reference))).toBe(true);
    expect(statusOrExpansionReferences.some((reference) => fiveVoltReferences.has(reference))).toBe(false);

    for (const bias of intent.nativeResetNetwork.populatedBiases) {
      const resistor = (nodesByNet.get(bias.nativeNetName) ?? []).find((node) =>
        node.reference.startsWith("R")
      );
      if (resistor === undefined) throw new Error(`${bias.nativeNetName} lacks its bias resistor`);
      expect(ohms(components.get(resistor.reference)!.value)).toBe(bias.resistanceOhm);
      expect(otherNet(resistor.reference, resistor.pin, netByNode)).toBe(
        bias.bias === "pull_down_to_ground" ? "GND" : "+3V3"
      );
    }
    for (const direct of intent.nativeResetNetwork.directUnbiasedMotorControls) {
      expect((nodesByNet.get(direct.nativeNetName) ?? []).some((node) =>
        node.reference.startsWith("R")
      )).toBe(false);
    }
  });
});

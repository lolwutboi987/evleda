import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { contentIdentity } from "../../src/core/canonical.js";
import { parseRequirements } from "../../src/core/requirements.js";
import type { ApprovalRecord } from "../../src/domain/types.js";
import { componentSelectionStageExecutor } from "../../src/generators/component-selection-generator.js";
import { finalizeStageResult } from "../../src/generators/draft-utils.js";

import {
  ReferenceKicadBackendError,
  REFERENCE_KICAD_REQUIRED_NETS,
  assertReferenceBomComponentMetadata,
  assertReferencePcbComponentMetadata,
  assertReferenceSchematicComponentMetadata,
} from "../../src/integrations/reference-kicad-backend.js";
import {
  ROBOTICS_CONTROLLER_V0,
  type ReferenceControllerProfile,
} from "../../src/knowledge/reference-controller-v0.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  referenceControllerRevASourceBinding,
  type ReferenceNativeSourceRole,
} from "../../src/knowledge/reference-controller-native-contract.js";
import type {
  CuratedDatasheetIdentity,
  SourcingObservation,
} from "../../src/workflow/contracts.js";

interface PcbComponentFixture {
  reference: string;
  value: string;
  footprint: string;
  partNumber: string;
}

const boundNativeSourceBytes = async (role: ReferenceNativeSourceRole): Promise<Uint8Array> => {
  const binding = referenceControllerRevASourceBinding(role);
  const bytes = await readFile(path.resolve(binding.path));
  expect(contentIdentity(bytes), role).toEqual(binding.identity);
  return bytes;
};

function quoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function balancedForms(source: string, name: string): readonly string[] {
  const forms: string[] = [];
  let cursor = 0;
  const prefix = `(${name}`;
  while (cursor < source.length) {
    const start = source.indexOf(prefix, cursor);
    if (start < 0) break;
    const boundary = source[start + prefix.length];
    if (boundary !== undefined && !/[\s)]/u.test(boundary)) {
      cursor = start + prefix.length;
      continue;
    }
    let depth = 0;
    let quotedString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]!;
      if (quotedString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quotedString = false;
      } else if (character === '"') quotedString = true;
      else if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) throw new Error(`Unterminated ${name} form in bound native source.`);
    forms.push(source.slice(start, end));
    cursor = end;
  }
  return forms;
}

function csvRows(source: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (inQuotes) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') inQuotes = false;
      else field += character;
    } else if (character === '"') inQuotes = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (inQuotes) throw new Error("Unterminated CSV field in bound native source.");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/u, ""));
    rows.push(row);
  }
  return rows;
}

interface IndependentlyParsedComponent {
  readonly reference: string;
  readonly partNumber: string;
}

const directProperty = (form: string, name: string): string | null => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\(property\\s+"${escapedName}"\\s+"([^"]*)"`, "u").exec(form)?.[1] ?? null;
};

function independentlyParsePcbSelected(bytes: Uint8Array): readonly IndependentlyParsedComponent[] {
  return balancedForms(Buffer.from(bytes).toString("utf8"), "footprint").flatMap((form) => {
    const reference = directProperty(form, "Reference");
    const partNumber = directProperty(form, "MPN");
    return reference === null || partNumber === null || partNumber.length === 0
      ? []
      : [{ reference, partNumber }];
  });
}

function independentlyParseNetlistSelected(bytes: Uint8Array): readonly IndependentlyParsedComponent[] {
  return balancedForms(Buffer.from(bytes).toString("utf8"), "comp").flatMap((form) => {
    const reference = /\(ref\s+"([^"]+)"\)/u.exec(form)?.[1] ?? null;
    const partNumber =
      /\(field\s+\(name\s+"MPN"\)\s+"([^"]*)"\)/u.exec(form)?.[1] ??
      /\(property\s+\(name\s+"MPN"\)\s+\(value\s+"([^"]*)"\)\)/u.exec(form)?.[1] ??
      null;
    return reference === null || partNumber === null || partNumber.length === 0
      ? []
      : [{ reference, partNumber }];
  });
}

function independentlyParseBomSelected(bytes: Uint8Array): readonly IndependentlyParsedComponent[] {
  const rows = csvRows(Buffer.from(bytes).toString("utf8"));
  const header = rows[0] ?? [];
  const referenceIndex = header.indexOf("Reference");
  const partNumberIndex = header.indexOf("MPN");
  if (referenceIndex < 0 || partNumberIndex < 0) {
    throw new Error("Bound native BOM lacks exact Reference or MPN columns.");
  }
  return rows.slice(1).flatMap((row) => {
    const partNumber = row[partNumberIndex] ?? "";
    if (partNumber.length === 0) return [];
    return (row[referenceIndex] ?? "").split(",").flatMap((token) => {
      const range = /^(?<prefix>[A-Za-z]+)(?<start>\d+)-(?:(?<endPrefix>[A-Za-z]+))?(?<end>\d+)$/u.exec(token);
      if (range?.groups !== undefined) {
        const prefix = range.groups.prefix!;
        const endPrefix = range.groups.endPrefix ?? prefix;
        const start = Number(range.groups.start);
        const end = Number(range.groups.end);
        if (prefix !== endPrefix || end < start) throw new Error("Malformed bound native BOM range.");
        return Array.from({ length: end - start + 1 }, (_, index) => ({
          reference: `${prefix}${start + index}`,
          partNumber,
        }));
      }
      return token.length === 0 ? [] : [{ reference: token, partNumber }];
    });
  });
}

const naturalReferenceOrder = (left: string, right: string): number => {
  const leftMatch = /^(?<prefix>[A-Za-z]+)(?<number>\d+)$/u.exec(left)?.groups;
  const rightMatch = /^(?<prefix>[A-Za-z]+)(?<number>\d+)$/u.exec(right)?.groups;
  if (leftMatch === undefined || rightMatch === undefined) return left.localeCompare(right, "en-US");
  const prefixOrder = leftMatch.prefix!.localeCompare(rightMatch.prefix!, "en-US");
  return prefixOrder === 0
    ? Number(leftMatch.number) - Number(rightMatch.number)
    : prefixOrder;
};

function independentlyDerivedRoleReferences(
  components: readonly IndependentlyParsedComponent[],
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(ROBOTICS_CONTROLLER_V0.components.map((profileComponent) => [
    profileComponent.key,
    components
      .filter((component) => component.partNumber === profileComponent.partNumber)
      .map((component) => component.reference)
      .sort(naturalReferenceOrder),
  ]));
}

async function executeComponentSelection(options: {
  readonly curatedDatasheets?: readonly CuratedDatasheetIdentity[];
  readonly sourcing?: readonly SourcingObservation[];
} = {}) {
  const requirements = parseRequirements(
    "Build a two-channel brushed motor controller for a 7-16.8 V DC supply. " +
    "Each motor is limited to 0.5 A RMS with USB, CAN, UART, I2C, SPI, " +
    "two quadrature encoders, and SWD programming.",
  ).document;
  const approval: ApprovalRecord = {
    id: "approval_component_reference_fixture",
    kind: "requirements",
    projectId: "project_component_reference_fixture",
    runId: "run_component_reference_fixture",
    subjectDigest: requirements.identity.digest,
    policyVersion: "evleda-policy-v1",
    actor: {
      type: "human",
      id: "reviewer_component_reference_fixture",
      displayName: "Component reference fixture reviewer",
      role: "requirements_reviewer",
    },
    scope: "Exact component-reference fixture requirements",
    rationale: "Verify deterministic reference serialization.",
    createdAt: "2026-09-05T00:00:00.000Z",
  };
  return await componentSelectionStageExecutor.execute({
    projectId: approval.projectId,
    runId: "run_component_reference_fixture",
    designRevisionId: "revision_component_reference_fixture",
    requirements,
    requirementsApproval: approval,
    upstream: [finalizeStageResult("system_architecture", [], [], [])],
    upstreamSourceRevisionBindings: [],
    profile: ROBOTICS_CONTROLLER_V0,
    ...(options.curatedDatasheets === undefined
      ? {}
      : { curatedDatasheets: options.curatedDatasheets }),
    ...(options.sourcing === undefined ? {} : { sourcing: options.sourcing }),
  });
}

function boardForProfile(
  profile: ReferenceControllerProfile,
  mutate: (record: PcbComponentFixture, index: number) => PcbComponentFixture = (record) => record,
): Uint8Array {
  let index = 0;
  const footprints = profile.components.flatMap((component) =>
    REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators[component.key].map(
      (reference) => {
      const record = mutate({
        reference,
        value: component.partNumber,
        footprint: component.footprint,
        partNumber: component.partNumber,
      }, index);
      index += 1;
      return [
        `  (footprint "${quoted(record.footprint)}"`,
        `    (property "Reference" "${quoted(record.reference)}")`,
        `    (property "Value" "${quoted(record.value)}")`,
        `    (property "MPN" "${quoted(record.partNumber)}")`,
        "  )",
      ].join("\n");
      },
    ),
  );
  return Buffer.from(["(kicad_pcb", ...footprints, ")", ""].join("\n"), "utf8");
}

function fixtureRecords(
  profile: ReferenceControllerProfile,
  mutate: (record: PcbComponentFixture, index: number) => PcbComponentFixture = (record) => record,
): readonly PcbComponentFixture[] {
  let index = 0;
  return profile.components.flatMap((component) =>
    REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators[component.key].map(
      (reference) => {
      const record = mutate({
        reference,
        value: component.partNumber,
        footprint: component.footprint,
        partNumber: component.partNumber,
      }, index);
      index += 1;
      return record;
      },
    ),
  );
}

function schematicNetlistForProfile(
  profile: ReferenceControllerProfile,
  mutate?: (record: PcbComponentFixture, index: number) => PcbComponentFixture,
): Uint8Array {
  const components = fixtureRecords(profile, mutate).map((record) => [
    "    (comp",
    `      (ref "${quoted(record.reference)}")`,
    `      (value "${quoted(record.value)}")`,
    `      (footprint "${quoted(record.footprint)}")`,
    "      (property",
    "        (name \"MPN\")",
    `        (value "${quoted(record.partNumber)}")`,
    "      )",
    "    )",
  ].join("\n"));
  const nets = REFERENCE_KICAD_REQUIRED_NETS.map((name, index) => [
    "    (net",
    `      (code \"${index + 1}\")`,
    `      (name "${quoted(name)}")`,
    "    )",
  ].join("\n"));
  return Buffer.from([
    "(export",
    "  (components",
    ...components,
    "  )",
    "  (nets",
    ...nets,
    "  )",
    ")",
    "",
  ].join("\n"), "utf8");
}

function bomForProfile(
  profile: ReferenceControllerProfile,
  mutate?: (record: PcbComponentFixture, index: number) => PcbComponentFixture,
): Uint8Array {
  const records = fixtureRecords(profile, mutate);
  const rows = profile.components.map((component) => {
    const matching = records.filter((record) => record.partNumber === component.partNumber);
    const references = matching.map((record) => record.reference).join(",");
    return [references, component.partNumber, component.footprint, component.partNumber, component.quantity, ""]
      .map((field) => {
        const value = String(field);
        return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
      })
      .join(",");
  });
  return Buffer.from([
    "Reference,Value,Footprint,MPN,Quantity,DNP",
    ...rows,
    "",
  ].join("\n"), "utf8");
}

function expectMetadataFailure(bytes: Uint8Array): void {
  expect(() => assertReferencePcbComponentMetadata(bytes, ROBOTICS_CONTROLLER_V0)).toThrow(
    ReferenceKicadBackendError,
  );
  try {
    assertReferencePcbComponentMetadata(bytes, ROBOTICS_CONTROLLER_V0);
  } catch (error) {
    expect(error).toMatchObject({
      code: "GATE_FAILED",
      failureCode: "REFERENCE_COMPONENT_METADATA_FAILED",
    });
  }
}

const swappedDuplicateRoleReference = (record: PcbComponentFixture): PcbComponentFixture => {
  const motorReferences =
    REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.motor_driver;
  const encoderReferences =
    REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.encoder_buffer;
  const swaps = new Map<string, string>([
    ...motorReferences.map((reference, index) => [reference, encoderReferences[index]!] as const),
    ...encoderReferences.map((reference, index) => [reference, motorReferences[index]!] as const),
  ]);
  return { ...record, reference: swaps.get(record.reference) ?? record.reference };
};

describe("reference PCB selected-component metadata", () => {
  it("emits legacy v1 selection and core-BOM references from the canonical native arrays", async () => {
    const result = await executeComponentSelection();
    const selectionArtifact = result.artifacts.find(
      (artifact) => artifact.logicalName === "components/selection.json",
    );
    const coreBomArtifact = result.artifacts.find(
      (artifact) => artifact.logicalName === "components/core-bom.csv",
    );
    expect(selectionArtifact).toBeDefined();
    expect(coreBomArtifact).toBeDefined();

    const selection = JSON.parse(Buffer.from(selectionArtifact!.content).toString("utf8")) as {
      readonly schemaVersion: string;
      readonly components: readonly {
        readonly key: string;
        readonly referenceDesignators: string;
      }[];
    };
    expect(selection.schemaVersion).toBe("evleda.component-selection.v1");
    expect(Object.fromEntries(selection.components.map((component) => [
      component.key,
      component.referenceDesignators.split(","),
    ]))).toEqual(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators);

    const bomRows = csvRows(Buffer.from(coreBomArtifact!.content).toString("utf8"));
    const header = bomRows[0] ?? [];
    const referenceIndex = header.indexOf("reference");
    const partNumberIndex = header.indexOf("manufacturer_part_number");
    expect(referenceIndex).toBeGreaterThanOrEqual(0);
    expect(partNumberIndex).toBeGreaterThanOrEqual(0);
    const bomComponents = bomRows.slice(1).flatMap((row) =>
      (row[referenceIndex] ?? "").split(",").map((reference) => ({
        reference,
        partNumber: row[partNumberIndex] ?? "",
      })),
    );
    expect(independentlyDerivedRoleReferences(bomComponents)).toEqual(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators,
    );
  });

  it("rejects a prefix-only sourcing MPN and keeps generated selection/BOM on the exact profile OPN", async () => {
    const component = ROBOTICS_CONTROLLER_V0.components[0]!;
    const prefixedPartNumber = `${component.partNumber}-UNREVIEWED-SUFFIX`;
    const result = await executeComponentSelection({
      sourcing: [{
        component: component.key,
        manufacturerPartNumber: prefixedPartNumber,
        supplier: "fixture-supplier",
        url: "https://supplier.invalid/prefix-only",
        retrievedAt: "2026-09-05T00:00:00.000Z",
        availability: "in_stock",
        identity: contentIdentity("prefix-only-sourcing-observation"),
      }],
    });

    expect(result.blockers.map((blocker) => blocker.code)).toContain("SOURCING_PART_MISMATCH");
    const selectionArtifact = result.artifacts.find(
      (artifact) => artifact.logicalName === "components/selection.json",
    )!;
    const selection = JSON.parse(Buffer.from(selectionArtifact.content).toString("utf8")) as {
      readonly components: readonly {
        readonly key: string;
        readonly selectedPartNumber: string;
      }[];
    };
    expect(selection.components.find((entry) => entry.key === component.key)?.selectedPartNumber)
      .toBe(component.partNumber);
    expect(Buffer.from(result.artifacts.find(
      (artifact) => artifact.logicalName === "components/core-bom.csv",
    )!.content).toString("utf8")).not.toContain(prefixedPartNumber);
  });

  it("blocks duplicate datasheet/sourcing records with order-independent output", async () => {
    const component = ROBOTICS_CONTROLLER_V0.components[0]!;
    const datasheets: readonly CuratedDatasheetIdentity[] = [
      {
        component: component.key,
        url: component.datasheet.url,
        retrievedAt: "2026-09-05T00:00:00.000Z",
        identity: contentIdentity("duplicate-datasheet-a"),
      },
      {
        component: component.key,
        url: component.datasheet.url,
        retrievedAt: "2026-09-05T00:00:00.000Z",
        identity: contentIdentity("duplicate-datasheet-b"),
      },
    ];
    const sourcing: readonly SourcingObservation[] = [
      {
        component: component.key,
        manufacturerPartNumber: component.partNumber,
        supplier: "fixture-supplier-a",
        url: "https://supplier.invalid/a",
        retrievedAt: "2026-09-05T00:00:00.000Z",
        availability: "in_stock",
        identity: contentIdentity("duplicate-sourcing-a"),
      },
      {
        component: component.key,
        manufacturerPartNumber: component.partNumber,
        supplier: "fixture-supplier-b",
        url: "https://supplier.invalid/b",
        retrievedAt: "2026-09-05T00:00:00.000Z",
        availability: "in_stock",
        identity: contentIdentity("duplicate-sourcing-b"),
      },
    ];

    const first = await executeComponentSelection({ curatedDatasheets: datasheets, sourcing });
    const second = await executeComponentSelection({
      curatedDatasheets: [...datasheets].reverse(),
      sourcing: [...sourcing].reverse(),
    });
    expect(first.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["DATASHEET_SOURCE_DUPLICATE", "SOURCING_EVIDENCE_DUPLICATE"]),
    );
    expect(second.outputIdentity).toEqual(first.outputIdentity);
    expect(second.artifacts.map((artifact) => artifact.identity)).toEqual(
      first.artifacts.map((artifact) => artifact.identity),
    );
  });

  it("derives the reviewed role-reference ownership independently from bound native PCB, netlist, and BOM bytes", async () => {
    const [pcbBytes, netlistBytes, bomBytes] = await Promise.all([
      boundNativeSourceBytes("native_pcb"),
      boundNativeSourceBytes("schematic_netlist"),
      boundNativeSourceBytes("exported_bom"),
    ]);
    const derivedBySource = {
      native_pcb: independentlyDerivedRoleReferences(independentlyParsePcbSelected(pcbBytes)),
      schematic_netlist: independentlyDerivedRoleReferences(
        independentlyParseNetlistSelected(netlistBytes),
      ),
      exported_bom: independentlyDerivedRoleReferences(independentlyParseBomSelected(bomBytes)),
    };

    for (const [source, derived] of Object.entries(derivedBySource)) {
      expect(derived, source).toEqual(
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators,
      );
    }
    expect(assertReferencePcbComponentMetadata(pcbBytes, ROBOTICS_CONTROLLER_V0)).toEqual(
      assertReferenceSchematicComponentMetadata(netlistBytes, ROBOTICS_CONTROLLER_V0),
    );
    expect(assertReferenceBomComponentMetadata(bomBytes, ROBOTICS_CONTROLLER_V0)).toEqual(
      assertReferencePcbComponentMetadata(pcbBytes, ROBOTICS_CONTROLLER_V0),
    );
  });

  it("binds every selected MPN, value, footprint, and quantity to the profile", () => {
    const selected = assertReferencePcbComponentMetadata(
      boardForProfile(ROBOTICS_CONTROLLER_V0),
      ROBOTICS_CONTROLLER_V0,
    );

    expect(selected).toHaveLength(
      ROBOTICS_CONTROLLER_V0.components.reduce((total, component) => total + component.quantity, 0),
    );
    expect(selected.map((component) => component.reference)).toEqual(
      [...selected.map((component) => component.reference)].sort((left, right) =>
        left.localeCompare(right, "en-US"),
      ),
    );
  });

  it.each([
    {
      name: "MPN",
      mutate: (record: PcbComponentFixture, index: number) =>
        index === 0 ? { ...record, partNumber: "WRONG-MPN" } : record,
    },
    {
      name: "value",
      mutate: (record: PcbComponentFixture, index: number) =>
        index === 0 ? { ...record, value: "GENERIC-MCU" } : record,
    },
    {
      name: "footprint",
      mutate: (record: PcbComponentFixture, index: number) =>
        index === 0 ? { ...record, footprint: "Package_QFP:WRONG" } : record,
    },
  ])("rejects a selected-component $name mismatch", ({ mutate }) => {
    expectMetadataFailure(boardForProfile(ROBOTICS_CONTROLLER_V0, mutate));
  });

  it("rejects a missing selected component instead of accepting a lower quantity", () => {
    const complete = Buffer.from(boardForProfile(ROBOTICS_CONTROLLER_V0)).toString("utf8");
    const firstFootprintStart = complete.indexOf("  (footprint");
    const secondFootprintStart = complete.indexOf("  (footprint", firstFootprintStart + 1);
    expectMetadataFailure(Buffer.from(complete.slice(0, firstFootprintStart) + complete.slice(secondFootprintStart)));
  });

  it("binds the same selected metadata in a native schematic netlist and BOM export", () => {
    const pcb = assertReferencePcbComponentMetadata(
      boardForProfile(ROBOTICS_CONTROLLER_V0),
      ROBOTICS_CONTROLLER_V0,
    );
    const schematic = assertReferenceSchematicComponentMetadata(
      schematicNetlistForProfile(ROBOTICS_CONTROLLER_V0),
      ROBOTICS_CONTROLLER_V0,
    );
    const bom = assertReferenceBomComponentMetadata(
      bomForProfile(ROBOTICS_CONTROLLER_V0),
      ROBOTICS_CONTROLLER_V0,
    );

    expect(schematic).toEqual(pcb);
    expect(bom).toEqual(pcb);
  });

  it.each([
    ["PCB", () => assertReferencePcbComponentMetadata(
      boardForProfile(ROBOTICS_CONTROLLER_V0, swappedDuplicateRoleReference),
      ROBOTICS_CONTROLLER_V0,
    )],
    ["schematic netlist", () => assertReferenceSchematicComponentMetadata(
      schematicNetlistForProfile(ROBOTICS_CONTROLLER_V0, swappedDuplicateRoleReference),
      ROBOTICS_CONTROLLER_V0,
    )],
    ["BOM", () => assertReferenceBomComponentMetadata(
      bomForProfile(ROBOTICS_CONTROLLER_V0, swappedDuplicateRoleReference),
      ROBOTICS_CONTROLLER_V0,
    )],
  ] as const)(
    "rejects a coherent %s role-reference swap with unchanged MPNs, quantities, values, and footprints",
    (_source, validate) => {
      expect(validate).toThrow(ReferenceKicadBackendError);
      try {
        validate();
      } catch (error) {
        expect(error).toMatchObject({
          code: "GATE_FAILED",
          failureCode: "REFERENCE_COMPONENT_METADATA_FAILED",
          details: {
            componentKey: "motor_driver",
            expectedReferences:
              [...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.motor_driver]
                .sort((left, right) => left.localeCompare(right, "en-US")),
            observedReferences:
              [...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.encoder_buffer]
                .sort((left, right) => left.localeCompare(right, "en-US")),
          },
        });
      }
    },
  );

  it("rejects a rehashed BOM whose selected MPN no longer matches the profile", () => {
    const bytes = Buffer.from(bomForProfile(ROBOTICS_CONTROLLER_V0)).toString("utf8");
    expect(() =>
      assertReferenceBomComponentMetadata(
        Buffer.from(bytes.replaceAll("STM32G0B1CET6", "UNREVIEWED-MCU"), "utf8"),
        ROBOTICS_CONTROLLER_V0,
      ),
    ).toThrow(ReferenceKicadBackendError);
  });

  it.each([
    ["a quote inside an unquoted field", (source: string) => source.replace("U1", 'U"1')],
    [
      "trailing data after a quoted field",
      (source: string) => source.replace('"U6,U7"', '"U6,U7"trailing'),
    ],
  ] as const)("rejects BOM CSV with %s", (_name, mutate) => {
    const source = Buffer.from(bomForProfile(ROBOTICS_CONTROLLER_V0)).toString("utf8");
    try {
      assertReferenceBomComponentMetadata(Buffer.from(mutate(source)), ROBOTICS_CONTROLLER_V0);
      throw new Error("Expected malformed BOM CSV to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "TOOL_RESULT_INCONCLUSIVE",
        failureCode: "REFERENCE_BOM_PARITY_FAILED",
      });
    }
  });
});

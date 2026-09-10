import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { parseRequirements } from "../../src/core/requirements.js";
import {
  REFERENCE_SIMULATION_BACKEND_ID,
  REFERENCE_SIMULATION_MODEL_SCHEMA,
  REFERENCE_SIMULATION_NATIVE_TOPOLOGY_SOURCE_SCHEMA,
  REFERENCE_SIMULATION_REPORT_SCHEMA,
  ReferenceSimulationBackend,
  inspectReferenceSimulationTopologyDiagnostics,
  type ReferenceSimulationNativeTopologySource,
  type ReferenceSimulationReportDocument
} from "../../src/integrations/reference-simulation.js";
import { runSimulationBackend } from "../../src/generators/backend-runner.js";
import {
  ROBOTICS_CONTROLLER_V0,
  createReferenceControllerProfile,
  type ReferenceComponentKey,
  type ReferenceControllerProfile
} from "../../src/knowledge/reference-controller-v0.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
  referenceControllerRevASourceBinding
} from "../../src/knowledge/reference-controller-native-contract.js";
import type { SimulationCoverageItem, SimulationRequest } from "../../src/workflow/contracts.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED_COVERAGE: readonly SimulationCoverageItem[] = [
  "power_tree_operating_points",
  "logic_rail_load_budget",
  "motor_current_chop",
  "motor_driver_thermal",
  "fault_and_reset"
];

interface ExpectedComponentIdentity {
  readonly manufacturer: string;
  readonly partNumber: string;
  readonly package: string;
  readonly footprint: string;
  readonly datasheetUrl: string;
  readonly fileName: string;
  readonly datasheetSize: number;
  readonly datasheetDigest: string;
}

const EXPECTED_COMPONENT_IDENTITIES: Readonly<
  Record<ReferenceComponentKey, ExpectedComponentIdentity>
> = {
  mcu: {
    manufacturer: "STMicroelectronics",
    partNumber: "STM32G0B1CET6",
    package: "LQFP-48",
    footprint: "Package_QFP:LQFP-48_7x7mm_P0.5mm",
    datasheetUrl: "https://www.st.com/resource/en/datasheet/stm32g0b1cb.pdf",
    fileName: "stm32g0b1cb.pdf",
    datasheetSize: 3_971_768,
    datasheetDigest: "8433e47bc5da5cac459a1d3d5a6add183655061f5655d3c653248de65ca535c9"
  },
  motor_driver: {
    manufacturer: "Texas Instruments",
    partNumber: "DRV8874PWPR",
    package: "HTSSOP-16 PowerPAD (PWP)",
    footprint: "robotics_motor:DRV8874_PWP0016J",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/drv8874.pdf",
    fileName: "drv8874.pdf",
    datasheetSize: 2_536_495,
    datasheetDigest: "e28fdb554c58e0c949a21f825a7c985bafc807e9f190575eb02d531afb715c64"
  },
  buck_5v: {
    manufacturer: "Texas Instruments",
    partNumber: "LMR51420XFDDCR",
    package: "SOT-23-6 (DDC)",
    footprint: "robotics_power:TI_DDC0006A",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/lmr51420.pdf",
    fileName: "lmr51420.pdf",
    datasheetSize: 2_117_875,
    datasheetDigest: "8cc7e8bc4ef9adbaaebf47d6059a847796b004ad3cd82ce99102a0fa590693ea"
  },
  ldo_3v3: {
    manufacturer: "Texas Instruments",
    partNumber: "TLV75533PDBVR",
    package: "SOT-23-5 (DBV)",
    footprint: "Package_TO_SOT_SMD:SOT-23-5",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/tlv755p.pdf",
    fileName: "tlv755p.pdf",
    datasheetSize: 3_072_276,
    datasheetDigest: "c0fe7be9fea4e4c8d933142f59758f7a951e195a45ca4e7e17684153da018cbb"
  },
  can_transceiver: {
    manufacturer: "Texas Instruments",
    partNumber: "TCAN3413DR",
    package: "SOIC-8 (D)",
    footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/tcan3413.pdf",
    fileName: "tcan3413.pdf",
    datasheetSize: 2_080_472,
    datasheetDigest: "2c0e8963e7762bc91edf30a365cc10c31ce88e2ddda3b67a120c4158ae52930b"
  },
  usb_esd: {
    manufacturer: "STMicroelectronics",
    partNumber: "USBLC6-2SC6",
    package: "SOT-23-6L",
    footprint: "Package_TO_SOT_SMD:SOT-23-6",
    datasheetUrl: "https://www.st.com/resource/en/datasheet/usblc6-2.pdf",
    fileName: "usblc6-2.pdf",
    datasheetSize: 575_521,
    datasheetDigest: "bc30154f310cd631043214ed52571daefe04270587ec55072d49a23bd18b9068"
  },
  encoder_buffer: {
    manufacturer: "Texas Instruments",
    partNumber: "SN74LVC2G17DBVR",
    package: "SOT-23-6 (DBV)",
    footprint: "Package_TO_SOT_SMD:SOT-23-6",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/sn74lvc2g17.pdf",
    fileName: "sn74lvc2g17.pdf",
    datasheetSize: 1_888_823,
    datasheetDigest: "624dbe55679d2fed4123b0d7708cd0d295efcc78de395e71a0caf5cd13cbc216"
  },
  sensor_power_switch: {
    manufacturer: "Texas Instruments",
    partNumber: "TPS2553DBVR-1",
    package: "SOT-23-6 (DBV)",
    footprint: "Package_TO_SOT_SMD:SOT-23-6",
    datasheetUrl: "https://www.ti.com/lit/ds/symlink/tps2553.pdf",
    fileName: "tps2553.pdf",
    datasheetSize: 2_091_685,
    datasheetDigest: "8ab20570d3e126d7a13719135f2b6a8858244de7f6c771d7a4329b23e06afca8"
  }
};

const EXPECTED_PDF_SOURCES = Object.fromEntries(
  Object.values(EXPECTED_COMPONENT_IDENTITIES).map((component) => [
    component.fileName,
    {
      manufacturer: component.manufacturer,
      sourceUrl: component.datasheetUrl,
      byteIdentity: {
        algorithm: "sha256",
        size: component.datasheetSize,
        digest: component.datasheetDigest
      }
    }
  ])
) as Readonly<
  Record<
    string,
    {
      readonly manufacturer: string;
      readonly sourceUrl: string;
      readonly byteIdentity: {
        readonly algorithm: "sha256";
        readonly size: number;
        readonly digest: string;
      };
    }
  >
>;

const sourceDigest = "5e05e6d53b8b901d4a48fd3574ed9d7953719c0098e1b11e311323b85baa92c4";
const prompt = [
  "Build a two-channel brushed motor controller for a 7-16.8 V DC supply.",
  "Each motor is limited to 0.5 A RMS with USB, CAN, UART, I2C, SPI,",
  "two quadrature encoders, and SWD programming."
].join(" ");

const referenceRoot = path.resolve("reference-designs", "robotics-controller-v0");
const canonicalNetlistBinding = referenceControllerRevASourceBinding("schematic_netlist");
const nativeNetlistBytes = readFileSync(
  path.resolve(...canonicalNetlistBinding.path.split("/")),
);
const nativeNetlistIdentity = contentIdentity(nativeNetlistBytes);
if (
  canonicalJson(nativeNetlistIdentity) !== canonicalJson(canonicalNetlistBinding.identity)
) throw new Error("Native-contract schematic-netlist identity is stale.");

const topologySource = (
  content: Uint8Array = nativeNetlistBytes
): ReferenceSimulationNativeTopologySource => ({
  schemaVersion: REFERENCE_SIMULATION_NATIVE_TOPOLOGY_SOURCE_SCHEMA,
  logicalName: canonicalNetlistBinding.path,
  identity: contentIdentity(content),
  content
});

const nativeNetlistText = new TextDecoder().decode(nativeNetlistBytes).replaceAll("\r\n", "\n");

const replaceComponentValue = (source: string, reference: string, value: string): string => {
  const referenceMarker = `(ref "${reference}")`;
  const referenceIndex = source.indexOf(referenceMarker);
  const nextComponentIndex = source.indexOf("\n\t\t(comp", referenceIndex + referenceMarker.length);
  if (referenceIndex < 0 || nextComponentIndex < 0) throw new Error(`Missing component ${reference}.`);
  const block = source.slice(referenceIndex, nextComponentIndex);
  const changed = block.replace(/\(value "[^"]+"\)/u, `(value "${value}")`);
  if (changed === block) throw new Error(`Missing value for component ${reference}.`);
  return source.slice(0, referenceIndex) + changed + source.slice(nextComponentIndex);
};

const addComponent = (
  source: string,
  reference: string,
  value: string,
  library = "Device",
  part = "R"
): string => {
  const marker = "\n\t)\n\t(groups)";
  const index = source.indexOf(marker);
  if (index < 0) throw new Error("Missing KiCad components boundary.");
  const component = [
    "",
    "\t\t(comp",
    `\t\t\t(ref "${reference}")`,
    `\t\t\t(value "${value}")`,
    "\t\t\t(libsource",
    `\t\t\t\t(lib "${library}")`,
    `\t\t\t\t(part "${part}")`,
    "\t\t\t)",
    "\t\t\t(units",
    "\t\t\t\t(unit",
    `\t\t\t\t\t(name "${reference}")`,
    "\t\t\t\t\t(pins",
    "\t\t\t\t\t\t(pin (num \"1\"))",
    "\t\t\t\t\t\t(pin (num \"2\"))",
    "\t\t\t\t\t\t(pin (num \"3\"))",
    "\t\t\t\t\t)",
    "\t\t\t\t)",
    "\t\t\t)",
    "\t\t)"
  ].join("\n");
  return source.slice(0, index) + component + source.slice(index);
};

const updateNetBlock = (
  source: string,
  netName: string,
  update: (block: string) => string
): string => {
  const nameMarker = `\t\t\t(name "${netName}")`;
  const nameIndex = source.indexOf(nameMarker, source.indexOf("\n\t(nets"));
  const blockStart = source.lastIndexOf("\n\t\t(net", nameIndex);
  const nextBlock = source.indexOf("\n\t\t(net", nameIndex + nameMarker.length);
  const blockEnd = nextBlock < 0 ? source.indexOf("\n\t)", nameIndex) : nextBlock;
  if (nameIndex < 0 || blockStart < 0 || blockEnd < 0) throw new Error(`Missing net ${netName}.`);
  const block = source.slice(blockStart, blockEnd);
  return source.slice(0, blockStart) + update(block) + source.slice(blockEnd);
};

const addNode = (source: string, netName: string, reference: string, pin: string): string =>
  updateNetBlock(source, netName, (block) => {
    const close = block.lastIndexOf("\n\t\t)");
    if (close < 0) throw new Error(`Malformed net ${netName}.`);
    const node = [
      "",
      "\t\t\t(node",
      `\t\t\t\t(ref "${reference}")`,
      `\t\t\t\t(pin "${pin}")`,
      "\t\t\t\t(pintype \"passive\")",
      "\t\t\t)"
    ].join("\n");
    return block.slice(0, close) + node + block.slice(close);
  });

const addBias = (
  source: string,
  reference: string,
  signalNet: string,
  railNet: string,
  value = "10k",
  library = "Device",
  part = "R"
): string => {
  let result = addComponent(source, reference, value, library, part);
  result = addNode(result, signalNet, reference, "1");
  return addNode(result, railNet, reference, "2");
};

const correctedTopology = (options: {
  readonly omitMotorAPwm?: boolean;
  readonly motorAPwmRail?: string;
  readonly motorAPwmValue?: string;
  readonly duplicateMotorASleep?: boolean;
  readonly wrongMotorASleepEndpoint?: boolean;
  readonly fakeMotorAPwmComponent?: boolean;
  readonly motorAPwmExtraNet?: string;
  readonly reuseMotorAPwmForMotorBPwm?: boolean;
} = {}): Uint8Array => {
  let source = nativeNetlistText;
  for (const reference of ["R12", "R13", "R18", "R26"]) {
    source = replaceComponentValue(source, reference, "10k");
  }
  if (!options.omitMotorAPwm) {
    source = addBias(
      source,
      "R901",
      "M1_PWM",
      options.motorAPwmRail ?? "GND",
      options.motorAPwmValue ?? "10k",
      "Device",
      options.fakeMotorAPwmComponent ? "C" : "R"
    );
    if (options.motorAPwmExtraNet !== undefined) {
      source = addNode(source, options.motorAPwmExtraNet, "R901", "3");
    }
  }
  if (options.reuseMotorAPwmForMotorBPwm) {
    source = addNode(source, "M2_PWM", "R901", "3");
  } else {
    source = addBias(source, "R902", "M2_PWM", "GND");
  }
  source = addBias(source, "R903", "M1_DIR", "GND");
  source = addBias(source, "R904", "M2_DIR", "GND");
  source = addBias(source, "R905", "SPI_CS", "+3V3");
  if (options.duplicateMotorASleep) source = addBias(source, "R906", "M1_SLEEP", "GND");
  if (options.wrongMotorASleepEndpoint) {
    source = updateNetBlock(source, "M1_SLEEP", (block) => {
      const changed = block.replace(
        /(\(ref "U6"\)\s+\(pin )"3"(\)\s+\(pinfunction "~\{SLEEP\}_3"\))/u,
        '$1"99"$2'
      );
      if (changed === block) throw new Error("Missing M1_SLEEP driver endpoint.");
      return changed;
    });
  }
  return new TextEncoder().encode(source);
};

const minimalSelfHashedTopology = (): Uint8Array => {
  const obligations = [
    ["M1_SLEEP", "GND", "U1", "24", "U6", "3"],
    ["M2_SLEEP", "GND", "U1", "25", "U7", "3"],
    ["M1_PWM", "GND", "U1", "28", "U6", "1"],
    ["M2_PWM", "GND", "U1", "29", "U7", "1"],
    ["M1_DIR", "GND", "U1", "17", "U6", "2"],
    ["M2_DIR", "GND", "U1", "18", "U7", "2"],
    ["SENSOR_PWR_EN", "GND", "U1", "21", "U8", "3"],
    ["CAN_STB", "+3V3", "U1", "32", "U5", "8"],
    ["SPI_CS", "+3V3", "U1", "37", "J10", "6"]
  ] as const;
  const pinsByReference = new Map<string, Set<string>>();
  const netNodes = new Map<string, { reference: string; pin: string }[]>();
  const add = (net: string, reference: string, pin: string): void => {
    const pins = pinsByReference.get(reference) ?? new Set<string>();
    pins.add(pin);
    pinsByReference.set(reference, pins);
    const nodes = netNodes.get(net) ?? [];
    nodes.push({ reference, pin });
    netNodes.set(net, nodes);
  };
  obligations.forEach(([signalNet, safeRail, mcu, mcuPin, endpoint, endpointPin], index) => {
    const resistor = `R${900 + index}`;
    add(signalNet, mcu, mcuPin);
    add(signalNet, endpoint, endpointPin);
    add(signalNet, resistor, "1");
    add(safeRail, resistor, "2");
  });
  const components = [...pinsByReference.entries()].sort().map(([reference, pins]) => {
    const resistor = reference.startsWith("R");
    return [
      "\t\t(comp",
      `\t\t\t(ref "${reference}")`,
      `\t\t\t(value "${resistor ? "10k" : "FAKE"}")`,
      "\t\t\t(libsource",
      `\t\t\t\t(lib "${resistor ? "Device" : "Fake"}")`,
      `\t\t\t\t(part "${resistor ? "R" : "Fake"}")`,
      "\t\t\t)",
      "\t\t\t(units",
      "\t\t\t\t(unit",
      `\t\t\t\t\t(name "${reference}")`,
      "\t\t\t\t\t(pins",
      ...[...pins].sort().map((pin) => `\t\t\t\t\t\t(pin (num "${pin}"))`),
      "\t\t\t\t\t)",
      "\t\t\t\t)",
      "\t\t\t)",
      "\t\t)"
    ].join("\n");
  });
  const nets = [...netNodes.entries()].sort().map(([net, nodes]) => [
    "\t\t(net",
    `\t\t\t(name "${net}")`,
    ...nodes.map(({ reference, pin }) => [
      "\t\t\t(node",
      `\t\t\t\t(ref "${reference}")`,
      `\t\t\t\t(pin "${pin}")`,
      "\t\t\t)"
    ].join("\n")),
    "\t\t)"
  ].join("\n"));
  return new TextEncoder().encode([
    "(export",
    "\t(components",
    ...components,
    "\t)",
    "\t(nets",
    ...nets,
    "\t)",
    ")"
  ].join("\n"));
};

const requestFor = (
  profile: ReferenceControllerProfile = ROBOTICS_CONTROLLER_V0,
  expectedSourceRevisionDigest = sourceDigest,
  additionalUpstreamIdentities: readonly ReturnType<typeof contentIdentity>[] = []
): SimulationRequest => ({
  schemaVersion: "evleda.simulation-request.v1",
  expectedSourceRevisionDigest,
  profile,
  requirements: parseRequirements(prompt).document,
  upstreamArtifactIdentities: [
    contentIdentity("schematic-revision-a"),
    contentIdentity("firmware-contract-revision-a"),
    ...additionalUpstreamIdentities
  ]
});

interface MutableNumericSimulationRequest {
  profile: {
    inputVoltageMv: { minimum?: number; maximum?: number };
    motor: {
      channels?: number;
      rmsCurrentMaPerChannel?: number;
      currentChopMaPerChannel?: number;
    };
    rails: {
      nominalMv?: number | null;
      minimumMv?: number;
      maximumMv?: number;
      budgetMa?: number;
    }[];
  };
}

const numericMutationRequest = (
  mutate: (request: MutableNumericSimulationRequest) => void
): SimulationRequest => {
  const request = structuredClone(requestFor()) as unknown as MutableNumericSimulationRequest;
  mutate(request);
  return request as unknown as SimulationRequest;
};

const decode = (content: Uint8Array): ReferenceSimulationReportDocument =>
  JSON.parse(new TextDecoder().decode(content)) as ReferenceSimulationReportDocument;

const reportBy = (
  result: Awaited<ReturnType<ReferenceSimulationBackend["execute"]>>,
  coverageItem: SimulationCoverageItem
) => {
  const report = result.reports.find((candidate) => candidate.coverageItem === coverageItem);
  if (report === undefined) {
    throw new Error(`Missing ${coverageItem} report`);
  }
  return report;
};

const withRailBudget = (
  profile: ReferenceControllerProfile,
  railName: string,
  budgetMa: number
): ReferenceControllerProfile => ({
  ...structuredClone(profile),
  rails: profile.rails.map((rail) =>
    rail.name === railName ? { ...rail, budgetMa } : { ...rail }
  )
});

describe("deterministic reference simulation backend", () => {
  it("returns exactly the five required source-bound canonical reports", async () => {
    const backend = new ReferenceSimulationBackend();
    const request = requestFor();
    const [first, second] = await Promise.all([backend.execute(request), backend.execute(request)]);

    expect(backend.backendId).toBe(REFERENCE_SIMULATION_BACKEND_ID);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: "evleda.simulation-result.v1",
      sourceRevisionDigest: sourceDigest,
      tool: {
        name: "evleda-reference-analytic-critic",
        version: "2.2.0",
        adapter: "evleda",
        capabilityProfile: REFERENCE_SIMULATION_BACKEND_ID
      }
    });
    expect(first.reports.map((report) => report.coverageItem)).toEqual(REQUIRED_COVERAGE);
    expect(new Set(first.reports.map((report) => report.logicalName)).size).toBe(5);
    expect(first.reports.map((report) => [report.coverageItem, report.validationStatus])).toEqual([
      ["power_tree_operating_points", "not_run"],
      ["logic_rail_load_budget", "not_run"],
      ["motor_current_chop", "not_run"],
      ["motor_driver_thermal", "not_run"],
      ["fault_and_reset", "not_run"]
    ]);

    const observedPdfSources = new Map<
      string,
      (typeof EXPECTED_PDF_SOURCES)[string]
    >();
    for (const report of first.reports) {
      expect(report).toMatchObject({
        logicalName: `simulation/reference/${report.coverageItem}.json`,
        mediaType: "application/json",
        sourceRevisionDigest: sourceDigest,
        modelIdentity: {
          algorithm: "sha256",
          schemaVersion: REFERENCE_SIMULATION_MODEL_SCHEMA,
          canonicalizationVersion: "evleda-c14n-json-v1"
        }
      });
      const text = new TextDecoder().decode(report.content);
      const document = decode(report.content);
      expect(text).toBe(canonicalJson(document));
      expect(document).toMatchObject({
        schemaVersion: REFERENCE_SIMULATION_REPORT_SCHEMA,
        coverageItem: report.coverageItem,
        sourceRevisionDigest: sourceDigest,
        modelIdentity: report.modelIdentity,
        validationStatus: "not_run"
      });
      expect(canonicalIdentity(document.model, REFERENCE_SIMULATION_MODEL_SCHEMA)).toEqual(
        report.modelIdentity
      );
      expect(document.model.equations.length).toBeGreaterThan(0);
      expect(document.model.parameters.length).toBeGreaterThan(0);
      expect(Object.keys(document.model.toleranceAssumptions).length).toBeGreaterThan(0);
      expect(Object.keys(document.model.ambientCopperAndDutyAssumptions).length).toBeGreaterThan(0);
      expect(document.model.unsupportedSubcoverage.length).toBeGreaterThan(0);
      expect(document.evidenceBoundary.join(" ")).toMatch(/not SPICE\/FEA.*physical qualification.*safety proof/iu);
      expect(text).not.toMatch(/[A-Z]:\\|AppData|evleda-datasheets|retrievedAt|createdAt/iu);

      const sourceIds = new Set(document.model.sources.map((source) => source.id));
      for (const source of document.model.sources) {
        const expectedSource = EXPECTED_PDF_SOURCES[source.fileName];
        if (expectedSource === undefined) {
          throw new Error(`Unexpected simulation PDF source: ${source.fileName}`);
        }
        const sourceProjection = {
          manufacturer: source.manufacturer,
          sourceUrl: source.sourceUrl,
          byteIdentity: source.byteIdentity
        };
        expect(sourceProjection).toEqual(expectedSource);
        const priorSource = observedPdfSources.get(source.fileName);
        if (priorSource === undefined) {
          observedPdfSources.set(source.fileName, sourceProjection);
        } else {
          expect(sourceProjection).toEqual(priorSource);
        }
        expect(source.pdfPages.length).toBeGreaterThan(0);
        expect(source.pdfPageNumbering).toBe("1-based");
        expect(source.printedPages.length).toBe(source.pdfPages.length);
        expect(source.section.length).toBeGreaterThan(0);
      }
      for (const parameter of document.model.parameters) {
        expect(parameter.sourceIds.every((id) => sourceIds.has(id))).toBe(true);
      }
      for (const equation of document.model.equations) {
        expect(equation.sourceIds.every((id) => sourceIds.has(id))).toBe(true);
      }
    }
    expect(Object.fromEntries([...observedPdfSources.entries()].sort())).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_PDF_SOURCES).sort())
    );
  });

  it("keeps absent native topology and implementation evidence explicitly not run", async () => {
    const result = await new ReferenceSimulationBackend().execute(requestFor());
    const report = reportBy(result, "fault_and_reset");
    const document = decode(report.content);

    expect(report.validationStatus).toBe("not_run");
    expect(document.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "native_reset_topology_source", status: "not_run" }),
      expect.objectContaining({ id: "hardware_reset_biases", status: "not_run" }),
      expect.objectContaining({ id: "fault_and_revision_resources", status: "not_run" })
    ]));
    expect(document.conclusion).toMatch(/was not run.*required evidence is absent.*no passing/iu);
  });

  it("makes the default production backend block required coverage instead of fabricating PASS", async () => {
    const requirements = parseRequirements(prompt).document;
    const result = await runSimulationBackend({
      stage: "simulation_checks",
      context: {
        projectId: "project_topology_evidence",
        runId: "run_topology_evidence",
        designRevisionId: "revision_topology_evidence",
        profile: ROBOTICS_CONTROLLER_V0,
        requirements,
        upstream: [],
        upstreamSourceRevisionBindings: [],
        simulationBackend: new ReferenceSimulationBackend()
      },
      profile: ROBOTICS_CONTROLLER_V0,
      exactInputs: [requirements.identity],
      initialArtifacts: [],
      initialEvidence: [],
      initialBlockers: [],
      requiredCoverage: REQUIRED_COVERAGE
    });

    expect(result.blockers).toHaveLength(5);
    expect(result.blockers.every((blocker) => blocker.code === "SIMULATION_REPORT_NOT_PASSING")).toBe(true);
    for (const coverageItem of REQUIRED_COVERAGE) {
      expect(result.blockers.some((blocker) =>
        blocker.message.includes(`${coverageItem} status is not_run`)
      ), coverageItem).toBe(true);
    }
    expect(result.artifacts.find((artifact) =>
      artifact.logicalName === "simulation/reference/fault_and_reset.json"
    )).toMatchObject({ validationStatus: "not_run" });
  });

  it("forbids aggregate PASS while any declared subcoverage remains unsupported", async () => {
    const result = await new ReferenceSimulationBackend().execute(requestFor());
    for (const report of result.reports.map((entry) => decode(entry.content))) {
      expect(report.model.unsupportedSubcoverage.length, report.coverageItem).toBeGreaterThan(0);
      expect(report.checks, report.coverageItem).toContainEqual(expect.objectContaining({
        id: "unsupported_subcoverage",
        status: "not_run",
        actual: { unsupportedSubcoverageCount: report.model.unsupportedSubcoverage.length }
      }));
      expect(report.validationStatus, report.coverageItem).not.toBe("pass");
    }
  });

  it("keeps profile and hard-coded calculations NOT_RUN without native, compiled, and PCB inputs", async () => {
    const source = topologySource();
    const result = await new ReferenceSimulationBackend({ nativeTopologySource: source }).execute(
      requestFor(ROBOTICS_CONTROLLER_V0, sourceDigest, [source.identity])
    );
    for (const coverageItem of [
      "power_tree_operating_points",
      "logic_rail_load_budget",
      "motor_current_chop",
      "motor_driver_thermal"
    ] as const) {
      const report = decode(reportBy(result, coverageItem).content);
      expect(report.validationStatus, coverageItem).toBe("not_run");
      expect(report.checks, coverageItem).toContainEqual(expect.objectContaining({
        id: "implementation_input_binding",
        status: "not_run",
        actual: {
          nativeSchematicImplementationBound: true,
          compiledImplementationBound: false,
          nativePcbImplementationBound: false
        }
      }));
    }
  });

  it("requires a complete requirements, exclusions, verification, and acceptance allocation", async () => {
    const result = await new ReferenceSimulationBackend().execute(requestFor());
    for (const report of result.reports.map((entry) => decode(entry.content))) {
      expect(report.checks, report.coverageItem).toContainEqual(expect.objectContaining({
        id: "requirements_verification_acceptance_allocation",
        status: "not_run",
        actual: {
          requirementsDocumentPresent: true,
          requirementsAllocated: false,
          exclusionsAllocated: false,
          verificationAllocated: false,
          acceptanceAllocated: false
        }
      }));
    }
  });

  it("keeps current-chop compliance NOT_RUN without an approved excursion band", async () => {
    const report = decode(reportBy(
      await new ReferenceSimulationBackend().execute(requestFor()),
      "motor_current_chop"
    ).content);
    expect(report.validationStatus).toBe("not_run");
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "approved_current_chop_excursion_band",
      status: "not_run",
      actual: { approvedExcursionBandPresent: false }
    }));
  });

  it("keeps transition behavior NOT_RUN without compiled implementation evidence", async () => {
    const report = decode(reportBy(
      await new ReferenceSimulationBackend().execute(requestFor()),
      "fault_and_reset"
    ).content);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: "transition_invariant",
      status: "not_run",
      actual: expect.objectContaining({
        logicalTableConsistent: true,
        compiledTransitionEvidencePresent: false
      })
    }));
    expect(report.validationStatus).toBe("not_run");
  });

  it.each([
    {
      name: "0.5 RMS current",
      request: () => numericMutationRequest((value) => {
        value.profile.motor.rmsCurrentMaPerChannel = 0.5;
      }),
      code: "INPUT_FRACTIONAL_NUMBER",
      path: "$.profile.motor.rmsCurrentMaPerChannel"
    },
    {
      name: "negative rail budget",
      request: () => numericMutationRequest((value) => {
        value.profile.rails[2]!.budgetMa = -1;
      }),
      code: "INPUT_NUMBER_OUT_OF_RANGE",
      path: "$.profile.rails[2].budgetMa"
    },
    {
      name: "fractional 3300.5 mV nominal",
      request: () => numericMutationRequest((value) => {
        value.profile.rails[2]!.nominalMv = 3300.5;
      }),
      code: "INPUT_FRACTIONAL_NUMBER",
      path: "$.profile.rails[2].nominalMv"
    },
    {
      name: "NaN rail minimum",
      request: () => numericMutationRequest((value) => {
        value.profile.rails[1]!.minimumMv = Number.NaN;
      }),
      code: "INPUT_NONFINITE_NUMBER",
      path: "$.profile.rails[1].minimumMv"
    },
    {
      name: "infinite input maximum",
      request: () => numericMutationRequest((value) => {
        value.profile.inputVoltageMv.maximum = Number.POSITIVE_INFINITY;
      }),
      code: "INPUT_NONFINITE_NUMBER",
      path: "$.profile.inputVoltageMv.maximum"
    },
    {
      name: "missing nominal rail voltage",
      request: () => numericMutationRequest((value) => {
        delete value.profile.rails[2]!.nominalMv;
      }),
      code: "INPUT_REQUIRED_NUMBER_MISSING",
      path: "$.profile.rails[2].nominalMv"
    },
    {
      name: "unsafe integral channel count",
      request: () => numericMutationRequest((value) => {
        value.profile.motor.channels = Number.MAX_SAFE_INTEGER + 1;
      }),
      code: "INPUT_UNSAFE_INTEGER",
      path: "$.profile.motor.channels"
    }
  ])("returns closed UNSUPPORTED reports for $name before arithmetic", async ({ request, code, path: issuePath }) => {
    const backend = new ReferenceSimulationBackend();
    const first = await backend.execute(request());
    const second = await backend.execute(request());

    expect(first).toEqual(second);
    expect(first.reports).toHaveLength(5);
    expect(first.reports.every((report) => report.validationStatus === "unsupported")).toBe(true);
    for (const report of first.reports.map((entry) => decode(entry.content))) {
      expect(report.validationStatus, report.coverageItem).toBe("unsupported");
      expect(report.model).toMatchObject({
        equations: [],
        parameters: [],
        sources: [],
        profileBinding: { inputStatus: "unsupported", issueCode: code, issuePath }
      });
      expect(report.checks).toEqual([
        expect.objectContaining({
          id: "simulation_input_numeric_domain",
          status: "unsupported",
          actual: { issueCode: code, issuePath }
        })
      ]);
      expect(report.conclusion).toMatch(/unsupported.*no passing engineering conclusion/iu);
      expect(canonicalJson(report)).not.toMatch(/NaN|Infinity/gu);
    }
  });

  it("rejects a numeric accessor without invoking it", async () => {
    const request = structuredClone(requestFor()) as unknown as MutableNumericSimulationRequest;
    let getterCalls = 0;
    Object.defineProperty(request.profile.motor, "rmsCurrentMaPerChannel", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return 500;
      }
    });

    const result = await new ReferenceSimulationBackend().execute(
      request as unknown as SimulationRequest
    );
    expect(getterCalls).toBe(0);
    expect(result.reports.every((report) => report.validationStatus === "unsupported")).toBe(true);
    expect(decode(result.reports[0]!.content).checks[0]).toMatchObject({
      id: "simulation_input_numeric_domain",
      status: "unsupported",
      actual: {
        issueCode: "INPUT_ACCESSOR_REJECTED",
        issuePath: "$.profile.motor.rmsCurrentMaPerChannel"
      }
    });
  });

  it("rejects a proxied numeric carrier without invoking its traps", async () => {
    const request = structuredClone(requestFor()) as unknown as MutableNumericSimulationRequest;
    let trapCalls = 0;
    request.profile.motor = new Proxy(request.profile.motor, {
      get(target, property, receiver) {
        trapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
      ownKeys(target) {
        trapCalls += 1;
        return Reflect.ownKeys(target);
      }
    });
    const result = await new ReferenceSimulationBackend().execute(
      request as unknown as SimulationRequest
    );
    expect(trapCalls).toBe(0);
    expect(result.reports.every((report) => report.validationStatus === "unsupported")).toBe(true);
    expect(decode(result.reports[0]!.content).checks[0]).toMatchObject({
      id: "simulation_input_numeric_domain",
      status: "unsupported",
      actual: {
        issueCode: "INPUT_NONPLAIN_VALUE",
        issuePath: "$.profile.motor"
      }
    });
  });

  it("rejects an alternating root proxy before any descriptor trap", async () => {
    let trapCalls = 0;
    let alternate = false;
    const request = new Proxy(requestFor(), {
      getOwnPropertyDescriptor(target, property) {
        trapCalls += 1;
        alternate = !alternate;
        if (alternate) throw new Error("alternating descriptor trap");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        trapCalls += 1;
        alternate = !alternate;
        if (alternate) throw new Error("alternating ownKeys trap");
        return Reflect.ownKeys(target);
      }
    });

    const result = await new ReferenceSimulationBackend().execute(request);
    expect(trapCalls).toBe(0);
    expect(result.sourceRevisionDigest).toBe("0".repeat(64));
    expect(result.reports.every((report) => report.validationStatus === "unsupported")).toBe(true);
    expect(decode(result.reports[0]!.content).checks[0]).toMatchObject({
      id: "simulation_input_numeric_domain",
      status: "unsupported",
      actual: { issueCode: "INPUT_NONPLAIN_VALUE", issuePath: "$" }
    });
  });

  it("copies an own __proto__ field without mutating any prototype and rejects it as unknown", async () => {
    const request = structuredClone(requestFor()) as SimulationRequest & Record<string, unknown>;
    Object.defineProperty(request, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true
    });
    const result = await new ReferenceSimulationBackend().execute(request);

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(result.reports.every((report) => report.validationStatus === "unsupported")).toBe(true);
    expect(decode(result.reports[0]!.content).checks[0]).toMatchObject({
      actual: { issueCode: "INPUT_UNKNOWN_FIELD", issuePath: "$.__proto__" }
    });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("selects invalid fields canonically regardless of insertion order", async () => {
    const make = (reverse: boolean): SimulationRequest => {
      const request = structuredClone(requestFor()) as SimulationRequest & Record<string, unknown>;
      const entries = [
        ["aa_invalid", Number.NaN],
        ["zz_invalid", Number.POSITIVE_INFINITY]
      ] as const;
      for (const [key, value] of reverse ? [...entries].reverse() : entries) {
        Object.defineProperty(request, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      return request;
    };
    const backend = new ReferenceSimulationBackend();
    const first = await backend.execute(make(false));
    const second = await backend.execute(make(true));

    expect(first).toEqual(second);
    expect(first.reports.map((report) => report.content)).toEqual(
      second.reports.map((report) => report.content)
    );
    expect(decode(first.reports[0]!.content).checks[0]).toMatchObject({
      actual: { issueCode: "INPUT_NONFINITE_NUMBER", issuePath: "$.aa_invalid" }
    });
  });

  it("rejects a non-enumerable hidden array index", async () => {
    const request = structuredClone(requestFor()) as unknown as MutableNumericSimulationRequest;
    const firstRail = request.profile.rails[0]!;
    Object.defineProperty(request.profile.rails, "0", {
      value: firstRail,
      enumerable: false,
      configurable: true,
      writable: true
    });
    const result = await new ReferenceSimulationBackend().execute(
      request as unknown as SimulationRequest
    );

    expect(result.reports.every((report) => report.validationStatus === "unsupported")).toBe(true);
    expect(decode(result.reports[0]!.content).checks[0]).toMatchObject({
      actual: { issueCode: "INPUT_ACCESSOR_REJECTED", issuePath: "$.profile.rails[0]" }
    });
  });

  it.each([
    {
      name: "root schemaVersion",
      mutate(request: Record<string, unknown>) {
        delete request.schemaVersion;
      },
      code: "INPUT_STRUCTURE_INVALID",
      path: "$.schemaVersion"
    },
    {
      name: "component manufacturer",
      mutate(request: Record<string, unknown>) {
        const profile = request.profile as { components: Record<string, unknown>[] };
        delete profile.components[0]!.manufacturer;
      },
      code: "INPUT_STRUCTURE_INVALID",
      path: "$.profile"
    },
    {
      name: "requirements constraints",
      mutate(request: Record<string, unknown>) {
        const requirements = request.requirements as Record<string, unknown>;
        delete requirements.constraints;
      },
      code: "INPUT_STRUCTURE_INVALID",
      path: "$.requirements"
    }
  ])("returns deterministic UNSUPPORTED reports for a missing $name field", async ({ mutate, code, path: issuePath }) => {
    const request = structuredClone(requestFor()) as SimulationRequest & Record<string, unknown>;
    mutate(request);
    const result = await new ReferenceSimulationBackend().execute(request);

    expect(result.reports).toHaveLength(5);
    expect(result.reports.every((report) => report.validationStatus === "unsupported")).toBe(true);
    expect(decode(result.reports[0]!.content).checks[0]).toMatchObject({
      actual: { issueCode: code, issuePath }
    });
  });

  it("snapshots valid numeric inputs before model execution", async () => {
    const request = structuredClone(requestFor()) as unknown as MutableNumericSimulationRequest;
    const pending = new ReferenceSimulationBackend().execute(request as unknown as SimulationRequest);
    request.profile.rails[2]!.budgetMa = -1;
    const result = await pending;

    expect(result.reports.every((report) => report.validationStatus === "not_run")).toBe(true);
    const logic = decode(reportBy(result, "logic_rail_load_budget").content);
    expect(logic.checks.find((candidate) => candidate.id === "three_v3_headroom")?.actual).toMatchObject({
      budgetUa: 400_000
    });
  });

  it("rejects topology bytes that are not bound to an upstream artifact", async () => {
    const source = topologySource();
    const result = await new ReferenceSimulationBackend({ nativeTopologySource: source }).execute(
      requestFor()
    );
    const document = decode(reportBy(result, "fault_and_reset").content);

    expect(document.validationStatus).toBe("unsupported");
    expect(document.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "native_reset_topology_source", status: "unsupported" }),
      expect.objectContaining({ id: "hardware_reset_biases", status: "unsupported" })
    ]));
    expect(document.model.evidenceInputs).toEqual([
      expect.objectContaining({
        identity: source.identity,
        nativeContractIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
        canonicalSourceBinding: canonicalNetlistBinding,
        bindingStatus: "unbound"
      })
    ]);
  });

  it("derives the current Rev-A reset-bias failures from exact native netlist bytes", async () => {
    const source = topologySource();
    const result = await new ReferenceSimulationBackend({ nativeTopologySource: source }).execute(
      requestFor(ROBOTICS_CONTROLLER_V0, sourceDigest, [source.identity])
    );
    const document = decode(reportBy(result, "fault_and_reset").content);
    const evidence = document.model.profileBinding.nativeResetTopologyEvidence as {
      readonly sourceIdentity: ReturnType<typeof contentIdentity>;
      readonly passingFactCount: number;
      readonly failingFactCount: number;
      readonly facts: readonly {
        readonly signal: string;
        readonly status: string;
        readonly findings: readonly string[];
        readonly observedBiasResistors: readonly {
          readonly reference: string;
          readonly resistanceOhm: number | null;
          readonly connectedNets: readonly string[];
        }[];
      }[];
    };
    const bySignal = new Map(evidence.facts.map((fact) => [fact.signal, fact]));

    expect(document.validationStatus).toBe("fail");
    expect(evidence.sourceIdentity).toEqual(nativeNetlistIdentity);
    expect(evidence).toMatchObject({ passingFactCount: 0, failingFactCount: 9 });
    expect(bySignal.get("MOTOR_A_NSLEEP")).toMatchObject({
      status: "fail",
      findings: ["BIAS_VALUE_MISMATCH"],
      observedBiasResistors: [expect.objectContaining({
        reference: "R13",
        resistanceOhm: 100_000,
        connectedNets: ["GND", "M1_SLEEP"]
      })]
    });
    for (const signal of ["MOTOR_A_PWM", "MOTOR_B_PWM", "MOTOR_A_DIR", "MOTOR_B_DIR", "SPI_CS"]) {
      expect(bySignal.get(signal), signal).toMatchObject({
        status: "fail",
        findings: ["BIAS_RESISTOR_MISSING"]
      });
    }
    for (const signal of ["MOTOR_B_NSLEEP", "SENSOR_PWR_EN", "CAN_STB"]) {
      expect(bySignal.get(signal), signal).toMatchObject({
        status: "fail",
        findings: ["BIAS_VALUE_MISMATCH"]
      });
    }
  });

  it.each([
    {
      name: "missing resistor",
      bytes: correctedTopology({ omitMotorAPwm: true }),
      signal: "MOTOR_A_PWM",
      finding: "BIAS_RESISTOR_MISSING"
    },
    {
      name: "ambiguous resistor",
      bytes: correctedTopology({ duplicateMotorASleep: true }),
      signal: "MOTOR_A_NSLEEP",
      finding: "BIAS_RESISTOR_AMBIGUOUS"
    },
    {
      name: "wrong rail",
      bytes: correctedTopology({ motorAPwmRail: "+3V3" }),
      signal: "MOTOR_A_PWM",
      finding: "BIAS_RAIL_MISMATCH"
    },
    {
      name: "wrong value",
      bytes: correctedTopology({ motorAPwmValue: "47k" }),
      signal: "MOTOR_A_PWM",
      finding: "BIAS_VALUE_MISMATCH"
    },
    {
      name: "fake R-designated non-resistor",
      bytes: correctedTopology({ fakeMotorAPwmComponent: true }),
      signal: "MOTOR_A_PWM",
      finding: "BIAS_COMPONENT_TYPE_MISMATCH"
    },
    {
      name: "resistor connected to a third net",
      bytes: correctedTopology({ motorAPwmExtraNet: "USB_DP" }),
      signal: "MOTOR_A_PWM",
      finding: "BIAS_RESISTOR_TOPOLOGY_INVALID"
    },
    {
      name: "resistor reused across obligations",
      bytes: correctedTopology({ reuseMotorAPwmForMotorBPwm: true }),
      signal: "MOTOR_A_PWM",
      finding: "BIAS_RESISTOR_REUSED"
    }
  ])("diagnoses an untrusted topology with a $name without treating it as evidence", ({ bytes, signal, finding }) => {
    const source = topologySource(bytes);
    const diagnostics = inspectReferenceSimulationTopologyDiagnostics(source);

    expect(diagnostics.authority).toBe("diagnostic_only_not_evidence");
    expect(diagnostics.canonicalSourceMatch).toBe(false);
    expect(diagnostics.facts.find((fact) => fact.signal === signal)?.findings).toContain(finding);
    expect(() => new ReferenceSimulationBackend({ nativeTopologySource: source })).toThrow(
      /trusted Rev-A schematic_netlist contract binding/iu
    );
  });

  it("does not elevate a self-hashed corrected topology to evidence", async () => {
    const source = topologySource(correctedTopology());
    const diagnostics = inspectReferenceSimulationTopologyDiagnostics(source);
    expect(diagnostics).toMatchObject({
      authority: "diagnostic_only_not_evidence",
      canonicalSourceMatch: false,
      passingFactCount: 9,
      failingFactCount: 0
    });
    expect(() => new ReferenceSimulationBackend({ nativeTopologySource: source })).toThrow(
      /trusted Rev-A schematic_netlist contract binding/iu
    );

    const canonicalSource = topologySource();
    const canonicalResult = await new ReferenceSimulationBackend({
      nativeTopologySource: canonicalSource
    }).execute(requestFor(ROBOTICS_CONTROLLER_V0, sourceDigest, [canonicalSource.identity]));
    const canonicalDocument = decode(reportBy(canonicalResult, "fault_and_reset").content);
    expect(canonicalDocument.checks).toContainEqual(expect.objectContaining({
      id: "fault_and_revision_resources",
      status: "not_run"
    }));
  });

  it("rejects a node whose component or pin is not declared by the native component instance", () => {
    const undeclaredComponent = topologySource(new TextEncoder().encode(
      nativeNetlistText.replace('(ref "U6")\n\t\t\t\t(pin "3")\n\t\t\t\t(pinfunction "~{SLEEP}_3")', '(ref "U666")\n\t\t\t\t(pin "3")\n\t\t\t\t(pinfunction "~{SLEEP}_3")')
    ));
    expect(() => inspectReferenceSimulationTopologyDiagnostics(undeclaredComponent)).toThrow(
      /references undeclared component U666/iu
    );

    const undeclaredPin = topologySource(correctedTopology({ wrongMotorASleepEndpoint: true }));
    expect(() => inspectReferenceSimulationTopologyDiagnostics(undeclaredPin)).toThrow(
      /references undeclared pin U6\.99/iu
    );
  });

  it("rejects a self-hashed minimal netlist even when its invented topology diagnoses 9/9", () => {
    const source = topologySource(minimalSelfHashedTopology());
    const diagnostics = inspectReferenceSimulationTopologyDiagnostics(source);
    expect(diagnostics).toMatchObject({
      authority: "diagnostic_only_not_evidence",
      canonicalSourceMatch: false,
      passingFactCount: 9,
      failingFactCount: 0
    });
    expect(() => new ReferenceSimulationBackend({ nativeTopologySource: source })).toThrow(
      /trusted Rev-A schematic_netlist contract binding/iu
    );
  });

  it("rejects wrong but internally self-hashed topology bytes", () => {
    const changedBytes = new Uint8Array(nativeNetlistBytes.byteLength + 1);
    changedBytes.set(nativeNetlistBytes);
    changedBytes[changedBytes.length - 1] = 0x0a;
    const source = topologySource(changedBytes);
    expect(source.identity).not.toEqual(canonicalNetlistBinding.identity);
    expect(() => new ReferenceSimulationBackend({ nativeTopologySource: source })).toThrow(
      /trusted Rev-A schematic_netlist contract binding/iu
    );
  });

  it("rejects a stale native-topology identity before parsing", () => {
    const source = topologySource();
    expect(() => new ReferenceSimulationBackend({
      nativeTopologySource: { ...source, identity: { ...source.identity, digest: "0".repeat(64) } }
    })).toThrow(/identity does not reproduce/iu);
  });

  it("matches every pinned profile component to the current package and captured PDF identity", () => {
    const observed = Object.fromEntries(
      ROBOTICS_CONTROLLER_V0.components.map((component) => [
        component.key,
        {
          manufacturer: component.manufacturer,
          partNumber: component.partNumber,
          package: component.package,
          footprint: component.footprint,
          datasheetUrl: component.datasheet.url,
          datasheetSize: component.datasheet.identity?.size,
          datasheetDigest: component.datasheet.identity?.digest
        }
      ])
    );
    const expected = Object.fromEntries(
      Object.entries(EXPECTED_COMPONENT_IDENTITIES).map(([key, component]) => [
        key,
        {
          manufacturer: component.manufacturer,
          partNumber: component.partNumber,
          package: component.package,
          footprint: component.footprint,
          datasheetUrl: component.datasheetUrl,
          datasheetSize: component.datasheetSize,
          datasheetDigest: component.datasheetDigest
        }
      ])
    );

    expect(observed).toEqual(expected);
  });

  it("returns unsupported when any pinned component or PDF identity field changes", async () => {
    const backend = new ReferenceSimulationBackend();
    for (const componentKey of Object.keys(
      EXPECTED_COMPONENT_IDENTITIES
    ) as ReferenceComponentKey[]) {
      const original = ROBOTICS_CONTROLLER_V0.components.find(
        (component) => component.key === componentKey
      );
      if (original === undefined || original.datasheet.identity === undefined) {
        throw new Error(`Missing pinned component identity: ${componentKey}`);
      }

      const variants: readonly {
        readonly field: string;
        readonly component: ReferenceControllerProfile["components"][number];
      }[] = [
        {
          field: "manufacturer",
          component: { ...original, manufacturer: `${original.manufacturer}-changed` }
        },
        {
          field: "partNumber",
          component: { ...original, partNumber: `${original.partNumber}-changed` }
        },
        {
          field: "package",
          component: { ...original, package: `${original.package}-changed` }
        },
        {
          field: "footprint",
          component: { ...original, footprint: `${original.footprint}-changed` }
        },
        {
          field: "datasheet.url",
          component: {
            ...original,
            datasheet: { ...original.datasheet, url: `${original.datasheet.url}?changed=1` }
          }
        },
        {
          field: "datasheet.identity.size",
          component: {
            ...original,
            datasheet: {
              ...original.datasheet,
              identity: {
                ...original.datasheet.identity,
                size: original.datasheet.identity.size + 1
              }
            }
          }
        },
        {
          field: "datasheet.identity.digest",
          component: {
            ...original,
            datasheet: {
              ...original.datasheet,
              identity: { ...original.datasheet.identity, digest: "0".repeat(64) }
            }
          }
        }
      ];

      for (const variant of variants) {
        const profile: ReferenceControllerProfile = {
          ...structuredClone(ROBOTICS_CONTROLLER_V0),
          components: ROBOTICS_CONTROLLER_V0.components.map((component) =>
            component.key === componentKey ? variant.component : structuredClone(component)
          )
        };
        const result = await backend.execute(requestFor(profile));
        const identityCheck = decode(
          reportBy(result, "power_tree_operating_points").content
        ).checks.find((candidate) => candidate.id === "simulation_input_numeric_domain");

        expect(
          result.reports.every((report) => report.validationStatus === "unsupported"),
          `${componentKey}.${variant.field}`
        ).toBe(true);
        expect(identityCheck, `${componentKey}.${variant.field}`).toMatchObject({
          status: "unsupported",
          actual: { issueCode: "INPUT_STRUCTURE_INVALID", issuePath: "$.profile" }
        });
      }
    }
  });

  it("fails the logic budget rather than passing an over-budget mutation", async () => {
    const profile = withRailBudget(ROBOTICS_CONTROLLER_V0, "3V3", 200);
    const result = await new ReferenceSimulationBackend().execute(requestFor(profile));

    expect(result.reports.map((report) => report.coverageItem)).toEqual(REQUIRED_COVERAGE);
    const report = reportBy(result, "logic_rail_load_budget");
    expect(report.validationStatus).toBe("fail");
    const document = decode(report.content);
    expect(document.validationStatus).toBe("fail");
    expect(document.checks).toContainEqual(
      expect.objectContaining({
        id: "three_v3_headroom",
        status: "fail",
        actual: expect.objectContaining({
          budgetUa: 200_000,
          modeledLoadUa: 232_320,
          allowedLoadWith20PercentHeadroomUa: 160_000
        })
      })
    );
  });

  it("returns unsupported for a profile outside the pinned voltage range", async () => {
    const profile = createReferenceControllerProfile({
      inputVoltageMv: { minimum: 6_500, maximum: 16_800 }
    });
    const result = await new ReferenceSimulationBackend().execute(requestFor(profile));

    expect(result.reports).toHaveLength(5);
    expect(result.reports.every((report) => report.validationStatus === "unsupported")).toBe(true);
    for (const report of result.reports) {
      expect(report.sourceRevisionDigest).toBe(sourceDigest);
      expect(decode(report.content).checks).toContainEqual(
        expect.objectContaining({ id: "v0_input_envelope", status: "unsupported" })
      );
    }
  });

  it("changes the canonical model identity when any bound model input changes", async () => {
    const backend = new ReferenceSimulationBackend();
    const baseline = reportBy(await backend.execute(requestFor()), "logic_rail_load_budget");
    const mutatedProfile = withRailBudget(ROBOTICS_CONTROLLER_V0, "3V3", 399);
    const mutated = reportBy(
      await backend.execute(requestFor(mutatedProfile)),
      "logic_rail_load_budget"
    );

    expect(mutated.modelIdentity.digest).not.toBe(baseline.modelIdentity.digest);

    const baselineDocument = decode(baseline.content);
    const mutations: ReferenceSimulationReportDocument["model"][] = [];
    const equationMutation = structuredClone(baselineDocument.model);
    ((equationMutation.equations as unknown) as { expression: string }[])[0]!.expression +=
      "+mutation";
    mutations.push(equationMutation);
    const parameterMutation = structuredClone(baselineDocument.model);
    ((parameterMutation.parameters as unknown) as { value: number | string | null }[])[0]!.value =
      123;
    mutations.push(parameterMutation);
    const sourceMutation = structuredClone(baselineDocument.model);
    ((sourceMutation.sources as unknown) as { byteIdentity: { digest: string } }[])[0]!.byteIdentity.digest =
      "0".repeat(64);
    mutations.push(sourceMutation);
    const toleranceMutation = structuredClone(baselineDocument.model);
    (toleranceMutation.toleranceAssumptions as Record<string, unknown>).headroomPpm = 199_999;
    mutations.push(toleranceMutation);
    const ambientMutation = structuredClone(baselineDocument.model);
    (ambientMutation.ambientCopperAndDutyAssumptions as Record<string, unknown>).duty =
      "changed";
    mutations.push(ambientMutation);

    for (const changedModel of mutations) {
      expect(canonicalIdentity(changedModel, REFERENCE_SIMULATION_MODEL_SCHEMA).digest).not.toBe(
        baseline.modelIdentity.digest
      );
    }
  });

  it("binds report bytes to the exact requested source revision without changing the model", async () => {
    const backend = new ReferenceSimulationBackend();
    const first = reportBy(await backend.execute(requestFor()), "motor_current_chop");
    const changedDigest = "b".repeat(64);
    const second = reportBy(
      await backend.execute(requestFor(ROBOTICS_CONTROLLER_V0, changedDigest)),
      "motor_current_chop"
    );

    expect(first.modelIdentity).toEqual(second.modelIdentity);
    expect(first.content).not.toEqual(second.content);
    expect(second.sourceRevisionDigest).toBe(changedDigest);
    expect(decode(second.content).sourceRevisionDigest).toBe(changedDigest);
  });

  it("keeps current-chop and thermal claims narrower than physical behavior", async () => {
    const result = await new ReferenceSimulationBackend().execute(requestFor());
    const chop = decode(reportBy(result, "motor_current_chop").content);
    const thermal = decode(reportBy(result, "motor_driver_thermal").content);

    expect(chop.conclusion).toMatch(/was not run.*no passing engineering conclusion/iu);
    expect(chop.model.unsupportedSubcoverage).toEqual(
      expect.arrayContaining([
        "Motor-current ripple and overshoot",
        "Motor winding resistance and inductance",
        "Motor back-EMF and mechanical load",
        "Battery/source impedance and wiring inductance"
      ])
    );
    expect(thermal.conclusion).toMatch(/was not run.*no passing engineering conclusion/iu);
    expect(thermal.model.unsupportedSubcoverage).toEqual(
      expect.arrayContaining([
        "Worst-case rise/fall timing because the PDF supplies typical values only",
        "Worst-case RDS(on) versus temperature/package/board correlation",
        "Actual thermal-via fill, copper area/thickness, laminate, airflow, and enclosure"
      ])
    );
  });

  it("derives every non-pass conclusion from the aggregate report status", async () => {
    const chopProfile = createReferenceControllerProfile({
      motor: { ...ROBOTICS_CONTROLLER_V0.motor, currentChopMaPerChannel: 800 }
    });
    const thermalProfile = createReferenceControllerProfile({
      motor: { ...ROBOTICS_CONTROLLER_V0.motor, rmsCurrentMaPerChannel: 5_000 }
    });
    const failCases = [
      {
        coverageItem: "power_tree_operating_points" as const,
        profile: withRailBudget(ROBOTICS_CONTROLLER_V0, "5V_SENSOR", 5_000)
      },
      {
        coverageItem: "logic_rail_load_budget" as const,
        profile: withRailBudget(ROBOTICS_CONTROLLER_V0, "3V3", 200)
      },
      { coverageItem: "motor_current_chop" as const, profile: chopProfile },
      { coverageItem: "motor_driver_thermal" as const, profile: thermalProfile }
    ];
    for (const testCase of failCases) {
      const report = decode(reportBy(
        await new ReferenceSimulationBackend().execute(requestFor(testCase.profile)),
        testCase.coverageItem
      ).content);
      expect(report.validationStatus, testCase.coverageItem).toBe("fail");
      expect(report.conclusion, testCase.coverageItem).toMatch(/failed.*no passing engineering conclusion/iu);
    }

    const notRun = decode(reportBy(
      await new ReferenceSimulationBackend().execute(requestFor()),
      "fault_and_reset"
    ).content);
    expect(notRun.validationStatus).toBe("not_run");
    expect(notRun.conclusion).toMatch(/was not run.*no passing engineering conclusion/iu);

    const originalMcu = ROBOTICS_CONTROLLER_V0.components.find((component) => component.key === "mcu")!;
    const unsupportedProfile: ReferenceControllerProfile = {
      ...structuredClone(ROBOTICS_CONTROLLER_V0),
      components: ROBOTICS_CONTROLLER_V0.components.map((component) =>
        component.key === "mcu"
          ? { ...originalMcu, partNumber: `${originalMcu.partNumber}-unsupported` }
          : structuredClone(component)
      )
    };
    const unsupported = await new ReferenceSimulationBackend().execute(requestFor(unsupportedProfile));
    for (const report of unsupported.reports.map((entry) => decode(entry.content))) {
      expect(report.validationStatus, report.coverageItem).toBe("unsupported");
      expect(report.conclusion, report.coverageItem).toMatch(
        /is unsupported.*no passing engineering conclusion/iu
      );
    }
  });
});

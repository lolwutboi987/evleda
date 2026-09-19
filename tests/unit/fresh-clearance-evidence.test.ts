import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import {
  FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION,
  FRESH_CLEARANCE_EVIDENCE_LIMITS,
  FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION,
  FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION,
  FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION,
  FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION,
  createFreshNetClassPreparationEvidence,
  materializeAndReadFreshClearanceEvidence,
  materializeFreshNetClasses,
  parseFreshClearanceEvidenceReceipt,
  parseFreshNetClassPreparationEvidence,
  parseFreshNetClassSemanticAuthority,
  readFreshClearanceEvidence,
  readFreshNetClassSemanticAuthority,
  verifyFreshClearanceEvidenceReceipt,
  verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority,
  verifyFreshNetClassSemanticAuthority,
  assertFreshPlaneReferenceCopperScope,
  type FreshClearanceEvidenceReceipt,
  type FreshClearanceOperationOptions,
} from "../../src/harness/fresh-clearance-evidence.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import {
  createPcbDesignCompilationBundle,
  createPcbDesignCompilationBundleRef,
  type PcbDesignCompilationBundle,
} from "../../src/harness/pcb-design-compilation-bundle.js";
import {
  compilePcbDesignIntentDraft,
  type PcbReadOnlyLibraryResolver,
  type PcbResolvedFootprint,
  type PcbResolvedSymbol,
} from "../../src/harness/pcb-design-compiler.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-contract.js";
import { prepareFreshProject, type FreshProject } from "../../src/harness/fresh-project.js";
import {
  FRESH_NETCLASS_ASSIGNMENT_MODEL,
  assertEmptyDerivedNetClassAssignments,
  assertExactContractNetClassPatterns,
  createExactContractNetClassPatterns,
  exactContractNetClassPattern,
} from "../../src/harness/fresh-netclass-assignment.js";
import type { KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import type { KicadMcpSession } from "../../src/integrations/kicad-mcp-session.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { createKiCad10StockLibraryResolver } from "../../src/harness/kicad-library-resolver.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { materializeFreshPlaneNetClasses, readFreshPlaneNetClassSemanticAuthority, verifyFreshPlaneNetClassSemanticAuthority } from "../../src/harness/fresh-plane-netclasses.js";
import { createToolboxSavedCheckpointLifecycle } from "../../src/mcp/toolbox-fresh-checkpoint.js";
import { derivedPowerLibrarySources } from "../helpers/derived-power-bundle.js";

const execFile = promisify(execFileCallback);
const catalog = loadDeepRuleCatalog();
const capturedTechnicalLayers = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/authored-netclass-sync06-technical-layers.json", import.meta.url), "utf8")) as {
  nativeExecutionByTests: boolean;
  board: { base64: string; contentIdentity: { algorithm: "sha256"; digest: string; size: number } };
  auditedAdditionalItemNames: string[];
  nativeSourceFacts: { file: string; url: string; contentIdentity: { digest: string }; excerpts: { text: string }[] }[];
};
const capturedTechnicalBoardBytes = Buffer.from(capturedTechnicalLayers.board.base64, "base64");
const capturedTechnicalBoardSource = capturedTechnicalBoardBytes.toString("utf8");
const native05SourceBytes=readFileSync(new URL('../fixtures/usb-c-native-pads/native05-saved-post-move.kicad_pcb',import.meta.url));
const native05Source=native05SourceBytes.toString('utf8');
const native05Netlist=readFileSync(new URL('../fixtures/usb-c-native-pads/native05-sync.net',import.meta.url),'utf8');
const native05Draft=JSON.parse(readFileSync(new URL('../fixtures/usb-c-native-pads/native05-draft.json',import.meta.url),'utf8')) as {
  components: {reference:string;symbolLibId:string;footprintLibId:string;pins:{pin:string}[]}[];
};
const owned = new Set<string>();
const originalPostCommitFault = process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_POST_COMMIT_FAULT;
const originalPreReceiptFault = process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_PRE_RECEIPT_FAULT;

afterEach(async () => {
  if (originalPostCommitFault === undefined) delete process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_POST_COMMIT_FAULT;
  else process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_POST_COMMIT_FAULT = originalPostCommitFault;
  if (originalPreReceiptFault === undefined) delete process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_PRE_RECEIPT_FAULT;
  else process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_PRE_RECEIPT_FAULT = originalPreReceiptFault;
  for (const directory of [...owned]) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Refusing unsafe test cleanup.");
    await rm(resolved, { recursive: true, force: true });
    owned.delete(directory);
  }
});

const dcElectrical = (voltage: number, current: number) => ({
  voltage: { minimumV: voltage, nominalV: voltage, maximumV: voltage },
  current: { nominalA: current, maximumContinuousA: current, peakA: current, peakDurationMs: 1_000 },
  speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null },
});

const placement = (
  reference: string,
  edgePreference: "none" | "left" = "none",
  exactRotation = false,
) => ({
  reference,
  side: "front",
  regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
  allowedRotationsDeg: exactRotation ? [0] : [0, 90, 180, 270],
  minimumEdgeClearanceMm: 1,
  minimumCourtyardClearanceMm: 0.25,
  edgePreference,
});

const route = (net: string, topology: "point_to_point" | "tree" = "point_to_point") => ({
  net,
  topology,
  preferredLayer: "F.Cu",
  maxVias: 0,
  routeLength: { mode: "unbounded" },
});

const ledDraft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 30, heightMm: 20, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] },
  },
  components: [
    {
      reference: "J1", symbolLibId: "Connector_Generic:Conn_01x02", value: "POWER_IN",
      footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VCC" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } },
      ],
    },
    {
      reference: "R1", symbolLibId: "Device:R", value: "1k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VCC" } },
        { pin: "2", assignment: { kind: "net", net: "LED_A" } },
      ],
    },
    {
      reference: "D1", symbolLibId: "Device:LED", value: "GREEN",
      footprintLibId: "LED_SMD:LED_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "GND" } },
        { pin: "2", assignment: { kind: "net", net: "LED_A" } },
      ],
    },
    {
      reference: "C1", symbolLibId: "Device:C", value: "100nF",
      footprintLibId: "Capacitor_SMD:C_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VCC" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } },
      ],
    },
  ],
  nets: [
    { name: "VCC", role: "power_input", endpoints: [{ reference: "J1", pin: "1" }, { reference: "R1", pin: "1" }, { reference: "C1", pin: "1" }], electrical: dcElectrical(5, 0.1), netClassId: "POWER" },
    { name: "LED_A", role: "passive", endpoints: [{ reference: "R1", pin: "2" }, { reference: "D1", pin: "2" }], electrical: dcElectrical(2, 0.01), netClassId: "SIGNAL" },
    { name: "GND", role: "ground", endpoints: [{ reference: "J1", pin: "2" }, { reference: "D1", pin: "1" }, { reference: "C1", pin: "2" }], electrical: dcElectrical(0, 0.1), netClassId: "POWER" },
  ],
  netClasses: [
    { id: "POWER", traceWidthMm: 0.5, clearanceMm: 0.25, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu"] },
    { id: "SIGNAL", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu"] },
  ],
  placementConstraints: [placement("J1", "left", true), placement("R1"), placement("D1"), placement("C1")],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: 0.25,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: { mode: "forbidden", maxTotal: 0 },
    nets: [route("VCC", "tree"), route("LED_A"), route("GND", "tree")],
  },
  unresolved: [],
});

const dividerDraft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 30, heightMm: 20, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] },
  },
  components: [
    {
      reference: "J1", symbolLibId: "Connector_Generic:Conn_01x04", value: "DIVIDER_IO",
      footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VIN" } },
        { pin: "2", assignment: { kind: "net", net: "VOUT" } },
        { pin: "3", assignment: { kind: "net", net: "GND" } },
        { pin: "4", assignment: { kind: "no_connect" } },
      ],
    },
    {
      reference: "R1", symbolLibId: "Device:R", value: "10k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VIN" } },
        { pin: "2", assignment: { kind: "net", net: "VOUT" } },
      ],
    },
    {
      reference: "R2", symbolLibId: "Device:R", value: "10k",
      footprintLibId: "Resistor_SMD:R_0603_1608Metric", unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VOUT" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } },
      ],
    },
  ],
  nets: [
    { name: "VIN", role: "analog", endpoints: [{ reference: "J1", pin: "1" }, { reference: "R1", pin: "1" }], electrical: dcElectrical(3.3, 0.001), netClassId: "DEFAULT" },
    { name: "VOUT", role: "analog", endpoints: [{ reference: "J1", pin: "2" }, { reference: "R1", pin: "2" }, { reference: "R2", pin: "1" }], electrical: dcElectrical(1.65, 0.001), netClassId: "DEFAULT" },
    { name: "GND", role: "ground", endpoints: [{ reference: "J1", pin: "3" }, { reference: "R2", pin: "2" }], electrical: dcElectrical(0, 0.001), netClassId: "DEFAULT" },
  ],
  netClasses: [{ id: "DEFAULT", traceWidthMm: 0.25, clearanceMm: 0.2, copperToEdgeMm: 0.3, allowedLayers: ["F.Cu", "B.Cu"] }],
  placementConstraints: [placement("J1", "left", true), placement("R1"), placement("R2")],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: 0.2,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: { mode: "bounded", maxTotal: 3, diameterMm: 0.6, drillMm: 0.3, minimumAnnularRingMm: 0.15 },
    nets: [
      { ...route("VIN"), preferredLayer: "either", maxVias: 1 },
      { ...route("VOUT", "tree"), preferredLayer: "either", maxVias: 1 },
      { ...route("GND"), preferredLayer: "either", maxVias: 1 },
    ],
  },
  unresolved: [],
});

const symbolPins: Readonly<Record<string, readonly { readonly number: string; readonly function: string }[]>> = {
  "Connector_Generic:Conn_01x02": [{ number: "1", function: "Pin 1" }, { number: "2", function: "Pin 2" }],
  "Connector_Generic:Conn_01x04": [{ number: "1", function: "Pin 1" }, { number: "2", function: "Pin 2" }, { number: "3", function: "Pin 3" }, { number: "4", function: "Pin 4" }],
  "Device:R": [{ number: "1", function: "Terminal 1" }, { number: "2", function: "Terminal 2" }],
  "Device:C": [{ number: "1", function: "Terminal 1" }, { number: "2", function: "Terminal 2" }],
  "Device:LED": [{ number: "1", function: "Cathode" }, { number: "2", function: "Anode" }],
};

const footprintPads: Readonly<Record<string, readonly string[]>> = {
  "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical": ["1", "2"],
  "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical": ["1", "2", "3", "4"],
  "Resistor_SMD:R_0603_1608Metric": ["1", "2"],
  "Capacitor_SMD:C_0603_1608Metric": ["1", "2"],
  "LED_SMD:LED_0603_1608Metric": ["1", "2"],
};

const resolver: PcbReadOnlyLibraryResolver = {
  resolveSymbol: (libraryId): PcbResolvedSymbol | null => {
    const pins = symbolPins[libraryId];
    return pins === undefined ? null : {
      libraryId,
      source: "kicad-stock",
      unitCount: 1,
      componentKind: libraryId.startsWith("Connector_Generic:") ? "connector" : "generic",
      polarized: libraryId === "Device:LED",
      pins,
    };
  },
  resolveFootprint: (libraryId): PcbResolvedFootprint | null => {
    const pads = footprintPads[libraryId];
    return pads === undefined ? null : { libraryId, source: "kicad-stock", packageKind: "generic", pads };
  },
};

const bundle = (draft: unknown, prompt: string): PcbDesignCompilationBundle => {
  const compilation = compilePcbDesignIntentDraft(draft, { libraryResolver: resolver, deepRuleCatalog: catalog });
  if (compilation.disposition !== "ready") throw new Error(`Fixture did not compile: ${JSON.stringify(compilation.issues)}`);
  return createPcbDesignCompilationBundle(
    { originalPrompt: prompt, compilation },
    { libraryResolver: resolver, deepRuleCatalog: catalog },
  );
};

const KICAD_IDENTITY: KicadExecutableIdentity = Object.freeze({
  kind: "kicad-cli",
  path: "C:/fixture/kicad-cli.exe",
  version: "10.0.3",
  commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
  sha256: "a".repeat(64),
  sizeBytes: 1,
  capabilityHelpSha256: "b".repeat(64),
  confirmedCapabilities: Object.freeze(["pcb drc"]),
});

const boardSource = (
  netNames: readonly string[],
  options: Readonly<{
    readonly generatorVersion?: string;
    readonly extra?: string;
    readonly numericTable?: boolean;
  }> = {},
): string => {
  const numericTable = options.numericTable ?? true;
  const table = numericTable
    ? `(net 0 "")\n  ${netNames.map((name, index) => `(net ${index + 1} "${name}")`).join("\n  ")}`
    : "";
  const netReference = (name: string, index: number): string => numericTable ? `${index + 1} "${name}"` : `"${name}"`;
  return `(kicad_pcb
  (version 20250316)
  (generator "pcbnew")
  (generator_version "${options.generatorVersion ?? "10.0"}")
  (general)
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  ${table}
  ${netNames.map((name, index) => `(footprint "Test:Pad_${index + 1}"
    (layer "F.Cu")
    (at ${5 + index * 3} 5)
    (property "Reference" "X${index + 1}")
    (property "Value" "TEST")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net ${netReference(name, index)}))
  )`).join("\n  ")}
  ${options.extra ?? ""}
)
`;
};

interface Fixture {
  readonly project: FreshProject;
  readonly bundle: PcbDesignCompilationBundle;
  readonly options: FreshClearanceOperationOptions;
  readonly proPath: string;
  readonly pcbPath: string;
  readonly druPath: string;
}

const fixture = async (
  draft: unknown,
  prompt: string,
  name: string,
  pcb?: string,
): Promise<Fixture> => {
  const compiledBundle = bundle(draft, prompt);
  const root = await mkdtemp(path.join(os.tmpdir(), `evleda-clearance-${name}-`));
  owned.add(root);
  const outputDir = path.join(root, "output");
  const project = await prepareFreshProject({
    outputDir,
    name,
    resume: false,
    workflowKind: "generic",
    compilationBundle: compiledBundle,
    compilationBundleRef: createPcbDesignCompilationBundleRef(compiledBundle),
  });
  const pcbPath = project.pcbPath;
  await writeFile(pcbPath, pcb ?? boardSource(compiledBundle.contract.nets.map((net) => net.name)), "utf8");
  return {
    project,
    bundle: compiledBundle,
    options: { project, compilationBundle: compiledBundle, kicad: KICAD_IDENTITY },
    proPath: path.join(project.projectPath, `${name}.kicad_pro`),
    pcbPath,
    druPath: path.join(project.projectPath, `${name}.kicad_dru`),
  };
};

const remintReceiptIdentity = (receipt: Record<string, unknown>): void => {
  const payload = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "identity"));
  receipt.identity = canonicalIdentity(payload, FRESH_CLEARANCE_EVIDENCE_RECEIPT_SCHEMA_VERSION);
};

async function native05CheckpointFixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'evleda-clearance-native05-'));owned.add(root);
  // The board/draft/netlist are captured files. Library records, power symbol
  // and replay transport are offline fixtures, not new native qualification.
  await writeFile(path.join(root,'power.kicad_sym'),derivedPowerLibrarySources.power!,'utf8');
  const power=createKiCad10StockLibraryResolver({symbolRoot:root,footprintRoot:root,exactSymbolIds:['power:PWR_FLAG'],exactFootprintIds:[],stockSymbolNicknames:['power'],stockFootprintNicknames:[]});
  const libraryResolver:PcbReadOnlyLibraryResolver={
    resolveSymbol:libraryId=>{const component=native05Draft.components.find(item=>item.symbolLibId===libraryId);return component?{libraryId,source:'kicad-stock',unitCount:1,componentKind:'connector',polarized:false,pins:component.pins.map(pin=>({number:pin.pin,function:pin.pin}))}:null;},
    resolveFootprint:libraryId=>{const component=native05Draft.components.find(item=>item.footprintLibId===libraryId);return component?{libraryId,source:'kicad-stock',packageKind:'generic',pads:component.pins.map(pin=>pin.pin)}:null;},
    inspectExternalPowerFlag:()=>power.inspectExternalPowerFlag(),
  };
  const dependencies={libraryResolver,deepRuleCatalog:catalog},compilation=compilePcbPlaneDesignIntentDraft(native05Draft,dependencies);
  if(compilation.disposition!=='ready')throw new Error(JSON.stringify(compilation.issues));
  const compilationBundle=createPcbPlaneCompilationBundle({originalPrompt:'Offline replay of native05 saved USB-C checkpoint parser source.',compilation},dependencies);
  const project=await preparePlaneFreshProject({outputDir:path.join(root,'output'),name:'native05-parser',resume:false,compilationBundle,compilationBundleRef:createPcbPlaneCompilationBundleRef(compilationBundle)});
  let captures=0;
  const options={project,compilationBundle,kicad:KICAD_IDENTITY,captureNativeNetlist:async()=>{captures++;return native05Netlist;}};
  await materializeFreshPlaneNetClasses(options);
  const authority=await readFreshPlaneNetClassSemanticAuthority(options);
  await writeFile(project.pcbPath,native05SourceBytes);
  const bundleBytes=serializePcbPlaneCompilationBundle(compilationBundle),bundlePath=path.join(root,'bundle.json'),reportPath=path.join(root,'report.json');
  const expectedReport={schemaVersion:'evleda.offline-checkpoint-parser-fixture.v1',status:'needs_review'};
  await writeFile(bundlePath,bundleBytes);await writeFile(reportPath,JSON.stringify({...expectedReport,assurance:'Offline fixture only.'}));
  const lifecycle=createToolboxSavedCheckpointLifecycle({project,bundleBytes,bundlePath,reportPath,
    session:{readActivePcbSource:async(expected:string)=>{if(expected!==project.pcbPath)throw new Error('Unexpected fixture board path');return await readFile(project.pcbPath,'utf8');}} as unknown as KicadMcpSession,
    verifySemantics:()=>verifyFreshPlaneNetClassSemanticAuthority(authority,options),expectedReport:()=>expectedReport});
  return {project,options,authority,lifecycle,captures:()=>captures,reportPath};
}

const remintIdentity = (artifact: Record<string, unknown>, schemaVersion: string): void => {
  const payload = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "identity"));
  artifact.identity = canonicalIdentity(payload, schemaVersion);
};

const remintReceiptSourceSet = (receipt: Record<string, unknown>): void => {
  const sources = receipt.sourceIdentities as Record<string, unknown>;
  const acceptance = receipt.acceptanceEvidence as Record<string, unknown>;
  sources.ruleSourceSet = canonicalIdentity({
    schemaVersion: FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION,
    projectSettings: sources.projectSettings,
    customRules: sources.customRules,
    pcb: sources.pcb,
    kicad: receipt.kicad,
    resolution: receipt.ruleResolution,
  }, FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION);
  acceptance.pcbSha256 = (sources.pcb as { digest: string }).digest;
  acceptance.rulesSourceSha256 = (sources.ruleSourceSet as { digest: string }).digest;
  remintReceiptIdentity(receipt);
};

const syntheticClearanceReceipt = (
  source: FreshClearanceEvidenceReceipt,
  classCount: number,
  netCount: number,
): Record<string, unknown> => {
  const receipt = structuredClone(source) as unknown as Record<string, unknown>;
  const managedPrefix = `EVLEDA_${source.bundleIdentity.digest.slice(0, 12)}_C`;
  const classIds = Array.from({ length: classCount }, (_, index) => `CLASS${String(index + 1).padStart(2, "0")}`);
  const netNames = Array.from({ length: netCount }, (_, index) => `N${String(index + 1).padStart(3, "0")}`);
  const classForNet = (index: number): number => index % classCount;
  const classes = classIds.map((contractNetClassId, classIndex) => ({
    contractNetClassId,
    kicadNetClassName: `${managedPrefix}${String(classIndex + 1).padStart(2, "0")}`,
    traceWidthMm: 0.25,
    configuredClearanceMm: 0.2,
    netNames: netNames.filter((_name, netIndex) => classForNet(netIndex) === classIndex),
  }));
  const nets = netNames.map((name, index) => {
    const classIndex = classForNet(index);
    return {
      name,
      contractNetClassId: classIds[classIndex]!,
      kicadNetClassName: classes[classIndex]!.kicadNetClassName,
      configuredClearanceMm: 0.2,
      effectiveClearanceMm: 0.2,
    };
  });
  const pairs: Array<{
    leftNet: string;
    rightNet: string;
    effectiveClearanceMm: number;
    limitingSources: string[];
  }> = [];
  for (let leftIndex = 0; leftIndex < nets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nets.length; rightIndex += 1) {
      pairs.push({
        leftNet: nets[leftIndex]!.name,
        rightNet: nets[rightIndex]!.name,
        effectiveClearanceMm: 0.2,
        limitingSources: [...new Set([
          `netclass:${nets[leftIndex]!.contractNetClassId}`,
          `netclass:${nets[rightIndex]!.contractNetClassId}`,
        ])].sort(),
      });
    }
  }
  receipt.boardMinimumClearanceMm = 0;
  receipt.netClasses = classes;
  receipt.nets = nets;
  receipt.pairs = pairs;
  (receipt.acceptanceEvidence as Record<string, unknown>).netClasses = classes.map((entry) => ({
    id: entry.contractNetClassId,
    configuredClearanceMm: 0.2,
    effectiveClearanceMm: 0.2,
  }));
  remintReceiptIdentity(receipt);
  return receipt;
};

describe("closed authored netclass pattern grammar", () => {
  it.each([
    ["VIN", "^VIN$"], ["vin", "^vin$"], ["PWR+3.3", "^PWR\\+3\\.3$"],
    ["-12V_A.1-2", "^-12V_A\\.1-2$"], ["+3V3", "^\\+3V3$"], ["9".repeat(64), `^${"9".repeat(64)}$`],
  ])("emits the exact case-sensitive anchored regex for %s", (name, expected) => {
    expect(exactContractNetClassPattern(name)).toBe(expected);
    // This asserts the emitted regex language only; native matcher evidence is
    // independently captured, and its wildcard branch requires net inventory.
    const expression = new RegExp(expected!);
    expect(expression.test(name!)).toBe(true);
    for (const sentinel of [`X${name}`, `${name}X`, `/${name}`, name!.replaceAll(".", "X"), name!.toUpperCase(), name!.toLowerCase()]) {
      if (sentinel !== name) expect(expression.test(sentinel)).toBe(false);
    }
  });

  it.each(["", "__proto__", "CONSTRUCTOR", "prototype", "---", "...", "N*", "N?", "N[1]", "N/1", "N\\1", "^VIN$", "VIN\n", "N".repeat(65)])(
    "rejects names outside the authenticated grammar: %j", (name) => {
      expect(() => exactContractNetClassPattern(name)).toThrow(/closed-contract net name/);
    },
  );

  it("requires exact record keys, exclusive pattern inventory, and bounded managed-class inputs", () => {
    const assignments = [
      { netName: "A.1", kicadNetClassName: "EVLEDA_123456789abc_C01" },
      { netName: "a.1", kicadNetClassName: "EVLEDA_123456789abc_C02" },
    ];
    const expected = createExactContractNetClassPatterns(assignments);
    expect(() => assertExactContractNetClassPatterns([...expected].reverse(), expected)).not.toThrow();
    for (const value of [null, [], [...expected, expected[0]], [expected[0], expected[0]],
      [{ ...expected[0], priority: 0 }, expected[1]],
      [{ ...expected[0], pattern: "^A.1$" }, expected[1]],
      [{ ...expected[0], pattern: "A\\.1" }, expected[1]],
      [{ ...expected[0], netclass: "Default" }, expected[1]],
    ]) expect(() => assertExactContractNetClassPatterns(value, expected)).toThrow(/netclass patterns/);
    expect(() => createExactContractNetClassPatterns([...assignments, assignments[0]!])).toThrow(/unique/);
    expect(() => createExactContractNetClassPatterns([{ ...assignments[0]!, kicadNetClassName: "Default" }])).toThrow(/bundle-managed/);
    expect(() => createExactContractNetClassPatterns(Array.from({ length: 129 }, (_, index) => ({ ...assignments[0]!, netName: `N${index}` })))).toThrow(/bound/);
    for (const value of [{}, null]) expect(() => assertEmptyDerivedNetClassAssignments(value)).not.toThrow();
    for (const value of [undefined, [], "", { A: [] }, { A: [assignments[0]!.kicadNetClassName] }]) {
      expect(() => assertEmptyDerivedNetClassAssignments(value)).toThrow(/must be empty/);
    }
  });
});

describe("fresh KiCad clearance evidence", () => {
  it('prepares a checkpoint from the exact saved native05 USB-C source without altering source, rules or markers',async()=>{
    expect(contentIdentity(native05SourceBytes)).toEqual({algorithm:'sha256',digest:'24e3935b9e41cfb2df113bd5cfae3ae1884ec0e4f698011f16bd68f349bc1c9b',size:14440});
    const rootLayerTable=native05Source.slice(native05Source.indexOf('\t(layers'),native05Source.indexOf('\t(setup'));
    expect(rootLayerTable).not.toContain('Dwgs.User');
    expect(native05Source).toContain('(fp_text user "PCB Edge"');
    const current=await native05CheckpointFixture();
    const preserved=[current.project.pcbPath,current.project.rulesPath,current.project.markerPath,current.reportPath,
      path.join(current.project.projectPath,`${current.project.name}.kicad_pro`)];
    const checkpointPath=path.join(current.project.outputPath,'.evleda-pcb-agent-checkpoint.json');
    await expect(readFile(checkpointPath)).rejects.toMatchObject({code:'ENOENT'});
    const before=await Promise.all(preserved.map(file=>readFile(file)));
    expect(()=>assertFreshPlaneReferenceCopperScope(native05Source)).not.toThrow();
    expect(await readFreshPlaneNetClassSemanticAuthority(current.options)).toEqual(current.authority);
    expect(await verifyFreshPlaneNetClassSemanticAuthority(current.authority,current.options)).toEqual(current.authority);
    const publish=await current.lifecycle.prepareCheckpoint();
    expect(typeof publish).toBe('function'); // Preparation only; no checkpoint is published.
    expect(current.captures()).toBeGreaterThanOrEqual(3);
    expect(await Promise.all(preserved.map(file=>readFile(file)))).toEqual(before);
    await expect(readFile(checkpointPath)).rejects.toMatchObject({code:'ENOENT'});
    const board=parseFreshPcbSource(await readFile(current.project.pcbPath,'utf8'));
    expect(board.footprints.flatMap(fp=>fp.pads)).toHaveLength(24);
    expect(board.footprints.flatMap(fp=>fp.pads).filter(pad=>pad.physical.padType==='np_thru_hole')).toHaveLength(2);
    expect(board.footprints.flatMap(fp=>fp.pads).filter(pad=>pad.netName?.startsWith('unconnected-('))).toHaveLength(8);
  });

  it('accepts exact declared Dwgs.User identity and rejects conflicting or expanded native05 layer semantics',async()=>{
    const current=await native05CheckpointFixture();
    const withDeclaration=(row:string)=>native05Source.replace('(25 "Edge.Cuts" user)',`(25 "Edge.Cuts" user) ${row}`);
    for(const row of ['(17 "Dwgs.User" user)','(17 "Dwgs.User" user "Drawing display label")']){
      const source=withDeclaration(row);await writeFile(current.project.pcbPath,source,'utf8');
      expect(()=>assertFreshPlaneReferenceCopperScope(source)).not.toThrow();
      expect(await verifyFreshPlaneNetClassSemanticAuthority(current.authority,current.options)).toEqual(current.authority);
      expect(typeof await current.lifecycle.prepareCheckpoint()).toBe('function');
    }
    const variants:[string,string][]=[
      ...['Unknown.Layer','dwgs.User','Drawing display label','In1.Cu','*.Cu','F.Cu','B.Cu'].map(name=>[name,native05Source.replace('(layer "Dwgs.User")',`(layer "${name}")`)] as [string,string]),
      ['wrong ordinal',withDeclaration('(19 "Dwgs.User" user)')],
      ['copper ordinal',withDeclaration('(4 "Dwgs.User" user)')],
      ['copper type',withDeclaration('(17 "Dwgs.User" signal)')],
      ['reserved ordinal alias',withDeclaration('(17 "DrawingAlias" user)')],
      ['reserved ordinal copper alias',withDeclaration('(17 "Inner1.Cu" signal)')],
      ['unknown declaration type',withDeclaration('(17 "Dwgs.User" arbitrary)')],
      ['duplicate selector',native05Source.replace('(layer "Dwgs.User")','(layer "Dwgs.User") (layer "F.Cu")')],
      ['plural graphic selector',native05Source.replace('(layer "Dwgs.User")','(layers "Dwgs.User")')],
      ['unquoted selector',native05Source.replace('(layer "Dwgs.User")','(layer Dwgs.User)')],
      ['pad scope',native05Source.replace('(layers "F.Cu" "F.Mask" "F.Paste")','(layers "F.Cu" "F.Mask" "Dwgs.User")')],
      ['property scope',native05Source.replace('(layer "F.SilkS")','(layer "Dwgs.User")')],
      ['route scope',native05Source.replace(/\)\s*$/u,'(segment (start 1 1) (end 2 1) (width 0.25) (layer "Dwgs.User") (net "GND"))\n)')],
      ['board graphic scope',native05Source.replace(/\)\s*$/u,'(gr_line (start 1 1) (end 2 1) (stroke (width 0.1) (type solid)) (layer "Dwgs.User"))\n)')],
      ['unsupported file version',native05Source.replace('(version 20260206)','(version 20269999)')],
    ];
    for(const [name,source]of variants){
      expect(source,name).not.toBe(native05Source);await writeFile(current.project.pcbPath,source,'utf8');
      expect(()=>assertFreshPlaneReferenceCopperScope(source),name).toThrow();
      await expect(readFreshPlaneNetClassSemanticAuthority(current.options),name).rejects.toMatchObject({code:'UNSUPPORTED_PCB'});
      await expect(current.lifecycle.prepareCheckpoint(),name).rejects.toMatchObject({code:'UNSUPPORTED_PCB'});
      expect(await readFile(current.project.pcbPath,'utf8'),name).toBe(source);
    }
  });

  it("reads the exact captured populated -06 board with native technical item layers absent from its enabled-layer table", async () => {
    expect(capturedTechnicalLayers.nativeExecutionByTests).toBe(false);
    expect(capturedTechnicalBoardBytes).toHaveLength(12430);
    expect(contentIdentity(capturedTechnicalBoardBytes)).toEqual({
      algorithm: "sha256", digest: "47f5f64a2a02c5c914548d9dd70f3b7e06d1be4976c7273f2f9ab3db6e9ca870", size: 12430,
    });
    expect(contentIdentity(capturedTechnicalBoardBytes)).toEqual(capturedTechnicalLayers.board.contentIdentity);
    const current = await fixture(dividerDraft(), "Captured native technical layer vocabulary.", "native-technical-layers", capturedTechnicalBoardSource);
    const materialization = await materializeFreshNetClasses(current.options);
    const authority = await readFreshNetClassSemanticAuthority(current.options);
    const receipt = await readFreshClearanceEvidence(current.options);
    expect(receipt.sourceIdentities.pcb).toEqual(contentIdentity(capturedTechnicalBoardBytes));
    expect(receipt.nets.map((entry) => entry.name)).toEqual(["GND", "VIN", "VOUT"]);
    expect(authority.netClasses).toContainEqual(expect.objectContaining({
      name: materialization.netClasses[0]!.kicadNetClassName, clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3,
    }));
    await expect(verifyFreshClearanceEvidenceReceipt(receipt, current.options)).resolves.toEqual(receipt);
    await expect(materializeFreshNetClasses(current.options)).resolves.toMatchObject({ changed: false });
    expect(await readFile(current.pcbPath)).toEqual(capturedTechnicalBoardBytes);
  });

  it("accepts the audited back-side technical names in a derived test variant without enabling more copper layers", async () => {
    const footprintOffset = capturedTechnicalBoardSource.indexOf('\t(footprint "');
    expect(footprintOffset).toBeGreaterThan(0);
    const rootPrefix = capturedTechnicalBoardSource.slice(0, footprintOffset);
    let itemSource = capturedTechnicalBoardSource.slice(footprintOffset);
    for (const suffix of ["Cu", "SilkS", "Fab", "Mask", "Paste", "CrtYd"]) {
      itemSource = itemSource.replaceAll(`"F.${suffix}"`, `"B.${suffix}"`);
    }
    const derivedSource = rootPrefix + itemSource;
    const current = await fixture(dividerDraft(), "Derived backside technical-layer name variant.", "back-technical-layers", derivedSource);
    const result = await materializeAndReadFreshClearanceEvidence(current.options);
    expect(result.evidence.nets.map((entry) => entry.name)).toEqual(["GND", "VIN", "VOUT"]);
    expect((await readFile(current.pcbPath, "utf8")).slice(0, footprintOffset)).toBe(rootPrefix);
  });

  it("pins the eight-name vocabulary to native default-name lookup rather than the enabled-layer table", () => {
    expect(capturedTechnicalLayers.auditedAdditionalItemNames).toEqual([
      "F.SilkS", "B.SilkS", "F.Fab", "B.Fab", "F.Mask", "B.Mask", "F.Paste", "B.Paste",
    ]);
    const excerpt = (file: string) => capturedTechnicalLayers.nativeSourceFacts.find((entry) => entry.file === file)!.excerpts.map((entry) => entry.text).join("\n");
    const parser = excerpt("pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp");
    expect(parser).toContain("LSET::Name( PCB_LAYER_ID( layer ) )");
    expect(parser).toContain("m_layerIndices[untranslated] = PCB_LAYER_ID( layer )");
    expect(parser).toContain("m_board->SetEnabledLayers( enabledLayers )");
    expect(parser).toContain("lookUpLayer( m_layerIndices )");
    expect(parser).toContain("lookUpLayerSet( m_layerMasks )");
    const emitter = excerpt("pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp");
    expect(emitter).toContain("aBoard->GetEnabledLayers().CuStack()");
    expect(emitter).toContain("aBoard->GetEnabledLayers().TechAndUserUIOrder()");
    const names = excerpt("common/lset.cpp");
    for (const name of capturedTechnicalLayers.auditedAdditionalItemNames) expect(names).toContain(`wxT( "${name}" )`);
  });

  it("retains every selector, copper, override, and declared-table rejection on concrete variants of the populated native board", async () => {
    const current = await fixture(dividerDraft(), "Captured technical-layer negative variants.", "native-technical-negative", capturedTechnicalBoardSource);
    await materializeFreshNetClasses(current.options);
    const layer = '(layer "F.SilkS")';
    const padLayers = '(layers "F.Cu" "F.Mask" "F.Paste")';
    const cases: { name: string; mutate: (source: string) => string; message?: RegExp }[] = [
      { name: "front copper property", mutate: (source) => source.replace(layer, '(layer "F.Cu")'), message: /copper footprint property/i },
      { name: "back copper property", mutate: (source) => source.replace(layer, '(layer "B.Cu")'), message: /copper footprint property/i },
      ...["Unknown.Layer", "In1.Cu", "F.Adhes", "F.Silkscreen", "f.SilkS", "*.SilkS"].map((name) => ({
        name: `unadmitted property layer ${name}`, mutate: (source: string) => source.replace(layer, `(layer "${name}")`), message: /neither declared nor an audited technical layer/i,
      })),
      { name: "unquoted selector", mutate: (source) => source.replace(layer, "(layer F.SilkS)"), message: /exactly one well-formed layer child/i },
      { name: "extra selector value", mutate: (source) => source.replace(layer, '(layer "F.SilkS" hide)'), message: /exactly one well-formed layer child/i },
      { name: "nested selector form", mutate: (source) => source.replace(layer, '(layer "F.SilkS" (extra 1))') },
      { name: "duplicate selector", mutate: (source) => source.replace(layer, `${layer} (layer "F.Fab")`) },
      { name: "mixed property selectors", mutate: (source) => source.replace(layer, `${layer} (layers "F.Mask")`) },
      { name: "plural-only property selector", mutate: (source) => source.replace(layer, '(layers "F.Mask")') },
      { name: "copper footprint graphic", mutate: (source) => source.replace(/(\(fp_line[\s\S]*?\(layer )"F\.SilkS"/u, '$1"F.Cu"') },
      { name: "unknown pad mask", mutate: (source) => source.replace(padLayers, '(layers "F.Cu" "Other.Mask" "F.Paste")') },
      { name: "unquoted pad mask", mutate: (source) => source.replace(padLayers, '(layers "F.Cu" F.Mask "F.Paste")') },
      { name: "duplicate pad mask", mutate: (source) => source.replace(padLayers, '(layers "F.Cu" "F.Mask" "F.Mask")') },
      { name: "extra pad wildcard", mutate: (source) => source.replace(padLayers, '(layers "F.Cu" "*.Fab")') },
      { name: "undeclared inner copper pad", mutate: (source) => source.replace(padLayers, '(layers "In1.Cu" "F.Mask" "F.Paste")') },
      { name: "ambiguous pad selectors", mutate: (source) => source.replace(padLayers, `${padLayers} (layer "F.Cu")`) },
      { name: "duplicate pad selectors", mutate: (source) => source.replace(padLayers, `${padLayers} ${padLayers}`) },
      { name: "pad override", mutate: (source) => source.replace(padLayers, `${padLayers} (clearance 0.01)`) },
      { name: "footprint override", mutate: (source) => source.replace('(footprint "R_0603_1608Metric"', '(footprint "R_0603_1608Metric" (clearance 0.01)') },
      { name: "zone", mutate: (source) => source.replace('(embedded_fonts no)', '(zone (net "GND") (layer "F.Cu")) (embedded_fonts no)') },
      { name: "wrong declared copper ordinal", mutate: (source) => source.replace('(2 "B.Cu" signal)', '(31 "B.Cu" signal)') },
      { name: "duplicate declared ordinal", mutate: (source) => source.replace('(27 "Margin" user)', '(0 "Margin" user)') },
      { name: "missing declared front copper", mutate: (source) => source.replace('(0 "F.Cu" signal)', '') },
      { name: "additional declared copper", mutate: (source) => source.replace('(2 "B.Cu" signal)', '(2 "B.Cu" signal) (4 "In1.Cu" signal)') },
      { name: "reversed declared copper order", mutate: (source) => source.replace('(0 "F.Cu" signal)\r\n\t\t(2 "B.Cu" signal)', '(2 "B.Cu" signal)\r\n\t\t(0 "F.Cu" signal)') },
    ];
    for (const variant of cases) {
      const source = variant.mutate(capturedTechnicalBoardSource);
      expect(source, variant.name).not.toBe(capturedTechnicalBoardSource);
      await writeFile(current.pcbPath, source, "utf8");
      await expect(materializeFreshNetClasses(current.options), variant.name).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(readFreshNetClassSemanticAuthority(current.options), variant.name).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(readFreshClearanceEvidence(current.options), variant.name).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      if (variant.message !== undefined) await expect(readFreshClearanceEvidence(current.options), variant.name).rejects.toThrow(variant.message);
      expect(await readFile(current.pcbPath, "utf8"), variant.name).toBe(source);
    }
    await writeFile(current.pcbPath, capturedTechnicalBoardBytes);
    await writeFile(current.druPath, '(version 1)\n(rule "forbidden" (constraint clearance (min 0.01mm)))\n');
    await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_RULES" });
  });

  it("materializes escaped case-distinct contract patterns and keeps native empty-cache normalization semantically stable", async () => {
    const draft = JSON.parse(JSON.stringify(dividerDraft()).replaceAll('"VIN"', '"Power+3.3"').replaceAll('"VOUT"', '"power+3.3"'));
    const current = await fixture(draft, "Escaped exact authored assignments.", "escaped-patterns");
    const materialization = await materializeFreshNetClasses(current.options);
    const authority = await readFreshNetClassSemanticAuthority(current.options);
    const receipt = await readFreshClearanceEvidence(current.options);
    expect(materialization.assignmentModel).toEqual(FRESH_NETCLASS_ASSIGNMENT_MODEL);
    expect(authority.ruleResolution).toMatchObject(FRESH_NETCLASS_ASSIGNMENT_MODEL);
    const project = JSON.parse(await readFile(current.proPath, "utf8"));
    expect(project.net_settings.netclass_assignments).toEqual({});
    expect(project.net_settings.netclass_patterns).toEqual([
      { pattern: "^GND$", netclass: materialization.netClasses[0]!.kicadNetClassName },
      ...createExactContractNetClassPatterns(authority.contractNetAssignments).filter((entry) => entry.pattern !== "^GND$"),
    ]);
    expect(project.net_settings.netclass_patterns.map((entry: { pattern: string }) => entry.pattern)).toContain("^Power\\+3\\.3$");
    expect(project.net_settings.netclass_patterns.map((entry: { pattern: string }) => entry.pattern)).toContain("^power\\+3\\.3$");
    project.net_settings.netclass_assignments = null;
    project.net_settings.netclass_patterns.reverse();
    await writeFile(current.proPath, JSON.stringify(project));
    await expect(verifyFreshNetClassSemanticAuthority(authority, current.options)).resolves.toMatchObject({ identity: authority.identity });
    await expect(verifyFreshClearanceEvidenceReceipt(receipt, current.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
    await materializeFreshNetClasses(current.options);
    expect(JSON.parse(await readFile(current.proPath, "utf8")).net_settings.netclass_assignments).toBeNull();
    await expect(materializeFreshNetClasses(current.options)).resolves.toMatchObject({ changed: false });
    await expect(readFreshNetClassSemanticAuthority(current.options)).resolves.toEqual(authority);
    // The wildcard branch also sees literal anchors; a non-contract anchor-name
    // is rejected by the closed PCB net-name grammar, never silently admitted.
    await writeFile(current.pcbPath, boardSource([...current.bundle.contract.nets.map((net) => net.name), "^GND$"]));
    await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
  });

  it("rejects every authored-pattern drift on readback and replay without rewriting the source", async () => {
    const current = await fixture(ledDraft(), "Exact authored pattern drift.", "pattern-drift");
    await materializeFreshNetClasses(current.options);
    const baseline = JSON.parse(await readFile(current.proPath, "utf8"));
    const mutations: ((patterns: Record<string, unknown>[]) => unknown)[] = [
      () => [], (patterns) => patterns.slice(1), (patterns) => [...patterns, patterns[0]],
      (patterns) => patterns.map((entry, index) => index === 0 ? { ...entry, netclass: "Default" } : entry),
      (patterns) => patterns.map((entry, index) => index === 0 ? { ...entry, netclass: "EVLEDA_ffffffffffff_C01" } : entry),
      (patterns) => patterns.map((entry, index) => index === 0 ? { ...entry, unexpected: true } : entry),
      ...["*", "GND", "^GND.*$", "^gnd$", "^(GND)$", "^EXTRA$", "^GND$|^VCC$"].map((pattern) =>
        (patterns: Record<string, unknown>[]) => patterns.map((entry) => entry.pattern === "^GND$" ? { ...entry, pattern } : entry)),
    ];
    for (const mutate of mutations) {
      const project = structuredClone(baseline);
      project.net_settings.netclass_patterns = mutate(project.net_settings.netclass_patterns);
      const tampered = JSON.stringify(project);
      await writeFile(current.proPath, tampered);
      await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "AMBIGUOUS_RULES" });
      await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "AMBIGUOUS_RULES" });
      await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "AMBIGUOUS_RULES" });
      expect(await readFile(current.proPath, "utf8")).toBe(tampered);
    }
  });

  it("does not promote historical cache-only project state or v1 evidence to authored v2 authority", async () => {
    const current = await fixture(dividerDraft(), "Historical assignment state.", "historical-cache");
    const materialization = await materializeFreshNetClasses(current.options);
    const authority = await readFreshNetClassSemanticAuthority(current.options);
    const receipt = await readFreshClearanceEvidence(current.options);
    const preparation = createFreshNetClassPreparationEvidence(materialization, authority);
    const project = JSON.parse(await readFile(current.proPath, "utf8"));
    project.net_settings.netclass_patterns = [];
    project.net_settings.netclass_assignments = Object.fromEntries(authority.contractNetAssignments.map((entry) => [entry.netName, [entry.kicadNetClassName]]));
    const historicalProject = JSON.stringify(project);
    await writeFile(current.proPath, historicalProject);
    await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "AMBIGUOUS_RULES" });
    expect(await readFile(current.proPath, "utf8")).toBe(historicalProject);
    for (const [artifact, parse] of [
      [authority, parseFreshNetClassSemanticAuthority], [preparation, parseFreshNetClassPreparationEvidence], [receipt, parseFreshClearanceEvidenceReceipt],
    ] as const) {
      const historical = structuredClone(artifact) as unknown as Record<string, unknown>;
      const version = (historical.schemaVersion as string).replace(/\.v2$/u, ".v1");
      historical.schemaVersion = version;
      remintIdentity(historical, version);
      expect(() => parse(historical)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
    const wrongModel = structuredClone(materialization) as unknown as Record<string, unknown>;
    wrongModel.assignmentModel = { ...FRESH_NETCLASS_ASSIGNMENT_MODEL, netClassPatterns: "rejected" };
    remintIdentity(wrongModel, FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION);
    expect(() => createFreshNetClassPreparationEvidence(wrongModel as unknown as typeof materialization, authority)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("reads stable pre-authoring semantics from an empty PCB while final clearance still requires final nets", async () => {
    const current = await fixture(
      dividerDraft(),
      "Empty pre-authoring semantic fixture.",
      "empty-pre-authoring",
      boardSource([]),
    );
    const firstMaterialization = await materializeFreshNetClasses(current.options);
    const firstAuthority = await readFreshNetClassSemanticAuthority(current.options);

    expect(firstAuthority.schemaVersion).toBe(FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    expect(firstAuthority.contractNetAssignments).toEqual([
      { netName: "GND", contractNetClassId: "DEFAULT", kicadNetClassName: firstMaterialization.netClasses[0]!.kicadNetClassName },
      { netName: "VIN", contractNetClassId: "DEFAULT", kicadNetClassName: firstMaterialization.netClasses[0]!.kicadNetClassName },
      { netName: "VOUT", contractNetClassId: "DEFAULT", kicadNetClassName: firstMaterialization.netClasses[0]!.kicadNetClassName },
    ]);
    expect(firstAuthority.netClasses).toEqual([
      {
        bus_width: 12,
        clearance: 0.2,
        diff_pair_gap: 0.25,
        diff_pair_via_gap: 0.25,
        diff_pair_width: 0.25,
        line_style: 0,
        microvia_diameter: 0.3,
        microvia_drill: 0.1,
        name: firstMaterialization.netClasses[0]!.kicadNetClassName,
        pcb_color: "rgba(0, 0, 0, 0.000)",
        priority: -1,
        schematic_color: "rgba(0, 0, 0, 0.000)",
        track_width: 0.25,
        tuning_profile: "",
        via_diameter: 0.6,
        via_drill: 0.3,
        wire_width: 6,
      },
    ]);
    await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNASSIGNED_NET" });

    const secondMaterialization = await materializeFreshNetClasses(current.options);
    const secondAuthority = await readFreshNetClassSemanticAuthority(current.options);
    expect(firstMaterialization.changed).toBe(true);
    expect(secondMaterialization.changed).toBe(false);
    expect(secondMaterialization.identity).not.toEqual(firstMaterialization.identity);
    expect(secondAuthority.identity).toEqual(firstAuthority.identity);
    expect(secondAuthority).toEqual(firstAuthority);

    const preparation = createFreshNetClassPreparationEvidence(firstMaterialization, firstAuthority);
    expect(preparation).toMatchObject({
      schemaVersion: FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION,
      materializationIdentity: firstMaterialization.identity,
      semanticAuthorityIdentity: firstAuthority.identity,
    });
    const parsedPreparation = parseFreshNetClassPreparationEvidence(structuredClone(preparation));
    expect(parsedPreparation).toEqual(preparation);
    expect(Object.isFrozen(parsedPreparation)).toBe(true);
  });

  it("keeps semantic identity stable across raw normalization but rejects every supported semantic-rule drift", async () => {
    const current = await fixture(
      dividerDraft(),
      "Semantic drift fixture.",
      "semantic-drift",
      boardSource([]),
    );
    await materializeFreshNetClasses(current.options);
    const authority = await readFreshNetClassSemanticAuthority(current.options);
    const projectBaseline = await readFile(current.proPath, "utf8");
    const pcbBaseline = await readFile(current.pcbPath, "utf8");

    await writeFile(current.proPath, JSON.stringify(JSON.parse(projectBaseline)), "utf8");
    await writeFile(current.pcbPath, `\n${pcbBaseline}`, "utf8");
    await expect(verifyFreshNetClassSemanticAuthority(authority, current.options)).resolves.toMatchObject({ identity: authority.identity });
    await writeFile(current.proPath, projectBaseline, "utf8");
    await writeFile(current.pcbPath, pcbBaseline, "utf8");

    let project = JSON.parse(projectBaseline) as {
      board: { design_settings: { rules: { min_clearance: number } } };
      net_settings: {
        classes: Record<string, unknown>[];
        netclass_assignments: Record<string, string[]>;
        netclass_patterns: unknown[];
      };
    };
    const managed = project.net_settings.classes.find((entry) => typeof entry.name === "string" && entry.name.startsWith("EVLEDA_"))!;
    managed.clearance = 0.21;
    await writeFile(current.proPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });

    project = JSON.parse(projectBaseline) as typeof project;
    project.net_settings.netclass_assignments.VIN = [authority.contractNetAssignments[0]!.kicadNetClassName, "Default"];
    await writeFile(current.proPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "AMBIGUOUS_RULES" });

    project = JSON.parse(projectBaseline) as typeof project;
    project.board.design_settings.rules.min_clearance = 0.3;
    await writeFile(current.proPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await expect(verifyFreshNetClassSemanticAuthority(authority, current.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });

    project = JSON.parse(projectBaseline) as typeof project;
    project.net_settings.netclass_patterns.push(["*", authority.contractNetAssignments[0]!.kicadNetClassName]);
    await writeFile(current.proPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "AMBIGUOUS_RULES" });
    await writeFile(current.proPath, projectBaseline, "utf8");

    await writeFile(current.druPath, `(version 1)\n(rule "override" (constraint clearance (min 0.01mm)))\n`, "utf8");
    await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_RULES" });
    await rm(current.druPath, { force: true });

    await writeFile(current.pcbPath, boardSource([], {
      extra: `(footprint "Test:Override" (layer "F.Cu") (at 1 1) (clearance 0.1) (property "Reference" "X9") (property "Value" "X") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))`,
    }), "utf8");
    await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });

    await writeFile(current.pcbPath, boardSource([], {
      extra: `(zone (net "GND") (layer "F.Cu") (connect_pads (clearance 0.2)))`,
    }), "utf8");
    await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
    await writeFile(current.pcbPath, pcbBaseline, "utf8");

    await writeFile(current.pcbPath, boardSource([], { generatorVersion: "9.0" }), "utf8");
    await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
    await writeFile(current.pcbPath, pcbBaseline, "utf8");

    const changedKicad = { ...current.options, kicad: { ...KICAD_IDENTITY, sha256: "c".repeat(64) } };
    await expect(verifyFreshNetClassSemanticAuthority(authority, changedKicad)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
  });

  it("enforces closed path-free semantic and preparation identities", async () => {
    const current = await fixture(
      dividerDraft(),
      "Closed semantic authority fixture.",
      "closed-semantic-authority",
      boardSource([]),
    );
    const materialization = await materializeFreshNetClasses(current.options);
    const authority = await readFreshNetClassSemanticAuthority(current.options);
    expect(authority.kicad).not.toHaveProperty("path");
    expect(authority).not.toHaveProperty("changed");
    expect(authority).not.toHaveProperty("preimageProjectSettingsIdentity");
    expect(authority).not.toHaveProperty("projectSettingsIdentity");
    expect(authority).not.toHaveProperty("pcbIdentityAtMaterialization");
    expect(authority).not.toHaveProperty("sourceIdentities");
    expect(JSON.stringify(authority)).not.toContain(current.project.projectPath);

    const authorityVariants: Record<string, unknown>[] = [];
    const badIdentity = structuredClone(authority) as unknown as Record<string, unknown>;
    (badIdentity.identity as { digest: string }).digest = "0".repeat(64);
    authorityVariants.push(badIdentity);
    const rootPath = structuredClone(authority) as unknown as Record<string, unknown>;
    rootPath.projectPath = current.project.projectPath;
    remintIdentity(rootPath, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    authorityVariants.push(rootPath);
    const kicadPath = structuredClone(authority) as unknown as Record<string, unknown>;
    (kicadPath.kicad as Record<string, unknown>).path = "C:/forged/kicad-cli.exe";
    remintIdentity(kicadPath, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    authorityVariants.push(kicadPath);
    const nestedExtra = structuredClone(authority) as unknown as Record<string, unknown>;
    ((nestedExtra.netClasses as Record<string, unknown>[])[0]!).unexpected = true;
    remintIdentity(nestedExtra, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    authorityVariants.push(nestedExtra);
    const identityExtra = structuredClone(authority) as unknown as Record<string, unknown>;
    (identityExtra.identity as Record<string, unknown>).path = "C:/forged";
    authorityVariants.push(identityExtra);
    for (const variant of authorityVariants) {
      await expect(verifyFreshNetClassSemanticAuthority(variant, current.options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }

    const preparation = createFreshNetClassPreparationEvidence(materialization, authority);
    expect(preparation.kicad).not.toHaveProperty("path");
    expect(preparation).not.toHaveProperty("semanticAuthority");
    expect(JSON.stringify(preparation)).not.toContain(current.project.projectPath);
    const badPreparation = structuredClone(preparation) as unknown as Record<string, unknown>;
    badPreparation.projectPath = current.project.projectPath;
    remintIdentity(badPreparation, FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION);
    expect(() => parseFreshNetClassPreparationEvidence(badPreparation)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const boundaryTamper = structuredClone(materialization) as unknown as Record<string, unknown>;
    boundaryTamper.origin = "provider";
    remintIdentity(boundaryTamper, FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION);
    expect(() => createFreshNetClassPreparationEvidence(boundaryTamper as never, authority)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const commonTamper = structuredClone(materialization) as unknown as Record<string, unknown>;
    (commonTamper.freshMarkerContentIdentity as { digest: string }).digest = "d".repeat(64);
    remintIdentity(commonTamper, FRESH_NETCLASS_MATERIALIZATION_SCHEMA_VERSION);
    expect(() => createFreshNetClassPreparationEvidence(commonTamper as never, authority)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects legacy modules and noncanonical two-layer ordinal identities at every rule-source boundary", async () => {
    const current = await fixture(dividerDraft(), "Closed layer-table fixture.", "closed-layer-table");
    await materializeFreshNetClasses(current.options);
    const authority = await readFreshNetClassSemanticAuthority(current.options);
    const valid = boardSource(["VIN", "VOUT", "GND"]);
    const variants = [
      boardSource(["VIN", "VOUT", "GND"], {
        extra: `(module "Legacy:Override" (layer "F.Cu") (at 1 1) (clearance 0.01))`,
      }),
      valid.replace(`(31 "B.Cu" signal)`, `(0 "B.Cu" signal)`),
      valid
        .replace(`(0 "F.Cu" signal)`, `(31 "F.Cu" signal)`)
        .replace(`(31 "B.Cu" signal)`, `(0 "B.Cu" signal)`),
    ];
    for (const pcb of variants) {
      await writeFile(current.pcbPath, pcb, "utf8");
      await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(verifyFreshNetClassSemanticAuthority(authority, current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
    }

    const currentVersion = valid
      .replace(`(version 20250316)`, `(version 20260206)`)
      .replace(`(31 "B.Cu" signal)`, `(2 "B.Cu" signal)`)
      .replace(`(44 "Edge.Cuts" user)`, `(25 "Edge.Cuts" user)`);
    await writeFile(current.pcbPath, currentVersion, "utf8");
    await expect(materializeFreshNetClasses(current.options)).resolves.toBeDefined();
    await expect(readFreshNetClassSemanticAuthority(current.options)).resolves.toBeDefined();
    await expect(readFreshClearanceEvidence(current.options)).resolves.toBeDefined();
  });

  it("rejects noncanonical or unbound net ordinals across materialize, semantic, verify, and final reads", async () => {
    const current = await fixture(dividerDraft(), "Canonical net-ID fixture.", "canonical-net-ids");
    await materializeFreshNetClasses(current.options);
    const authority = await readFreshNetClassSemanticAuthority(current.options);
    const valid = boardSource(["VIN", "VOUT", "GND"]);
    const tableless = boardSource(["VIN", "VOUT", "GND"], { numericTable: false });
    const variants = [
      valid.replace(`(net 2 "VOUT")`, `(net 01 "VOUT")`),
      valid.replace(`(net 2 "VOUT")`, `(net 2147483648 "VOUT")`),
      valid.replace(`(net 2 "VOUT")`, `(net -1 "VOUT")`),
      tableless
        .replace(`(net "VIN")`, `(net 1 "VIN")`)
        .replace(`(net "VOUT")`, `(net 2 "VOUT")`)
        .replace(`(net "GND")`, `(net 3 "GND")`),
      tableless
        .replace(`(net "VIN")`, `(net 1 "VIN")`)
        .replace(`(net "VOUT")`, `(net 1 "VOUT")`)
        .replace(`(net "GND")`, `(net 3 "GND")`),
    ];
    for (const pcb of variants) {
      await writeFile(current.pcbPath, pcb, "utf8");
      await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(readFreshNetClassSemanticAuthority(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(verifyFreshNetClassSemanticAuthority(authority, current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
    }
  });

  it("rejects final-capture project drift before receipts on changed and unchanged materialization branches", async () => {
    const current = await fixture(dividerDraft(), "Final capture race fixture.", "final-capture-race");

    process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_PRE_RECEIPT_FAULT = "append-project-byte";
    await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });

    delete process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_PRE_RECEIPT_FAULT;
    const alreadyConfigured = await readFile(current.proPath);
    await expect(materializeFreshNetClasses(current.options)).resolves.toMatchObject({ changed: false });
    expect(await readFile(current.proPath)).toEqual(alreadyConfigured);

    process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_PRE_RECEIPT_FAULT = "append-project-byte";
    await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
  });

  it("materializes and reads a generic LED design with exact multi-class assignments", async () => {
    const current = await fixture(ledDraft(), "Create a safe generic LED indicator candidate.", "led-clearance");
    const before = JSON.parse(await readFile(current.proPath, "utf8")) as Record<string, unknown>;
    (before as { operator_note?: unknown }).operator_note = { preserve: true, nested: [1, 2, 3] };
    await writeFile(current.proPath, `${JSON.stringify(before, null, 2)}\n`, "utf8");

    const result = await materializeAndReadFreshClearanceEvidence(current.options);
    expect(result.materialization.changed).toBe(true);
    expect(result.evidence.acceptanceEvidence.netClasses).toEqual([
      { id: "POWER", configuredClearanceMm: 0.25, effectiveClearanceMm: 0.25 },
      { id: "SIGNAL", configuredClearanceMm: 0.2, effectiveClearanceMm: 0.25 },
    ]);
    expect(result.evidence.nets).toEqual([
      expect.objectContaining({ name: "GND", contractNetClassId: "POWER", effectiveClearanceMm: 0.25 }),
      expect.objectContaining({ name: "LED_A", contractNetClassId: "SIGNAL", effectiveClearanceMm: 0.25 }),
      expect.objectContaining({ name: "VCC", contractNetClassId: "POWER", effectiveClearanceMm: 0.25 }),
    ]);
    expect(result.evidence.pairs).toHaveLength(3);
    expect(result.evidence.ruleResolution).toEqual({
      boardMinimum: "absolute-floor",
      netClassConflict: "larger-clearance",
      customRules: "absent-or-empty-only",
      localPadOrFootprintOverrides: "rejected",
      zones: "rejected",
      ...FRESH_NETCLASS_ASSIGNMENT_MODEL,
    });
    expect(result.evidence.acceptanceEvidence.pcbSha256).toBe(contentIdentity(await readFile(current.pcbPath)).digest);
    expect(result.evidence.sourceIdentities.ruleSourceSet.digest).toBe(result.evidence.acceptanceEvidence.rulesSourceSha256);
    expect(result.evidence.kicad).not.toHaveProperty("path");
    const after = JSON.parse(await readFile(current.proPath, "utf8")) as {
      operator_note?: unknown;
      net_settings: {
        classes: Record<string, unknown>[];
        netclass_assignments: Record<string, string[]>;
      };
    };
    expect(after.operator_note).toEqual({ preserve: true, nested: [1, 2, 3] });

    const unrelatedClass = structuredClone(after.net_settings.classes.find((entry) => entry.name === "Default")!);
    unrelatedClass.name = "OperatorAuxiliary";
    unrelatedClass.clearance = 0.4;
    after.net_settings.classes.push(unrelatedClass);
    await writeFile(current.proPath, `${JSON.stringify(after, null, 2)}\n`, "utf8");
    await materializeFreshNetClasses(current.options);
    const preserved = JSON.parse(await readFile(current.proPath, "utf8")) as typeof after;
    expect(preserved.net_settings.classes).toContainEqual(expect.objectContaining({ name: "OperatorAuxiliary", clearance: 0.4 }));
    expect(preserved.net_settings.netclass_assignments).toEqual({});

    const again = await materializeFreshNetClasses(current.options);
    expect(again.changed).toBe(false);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.nets)).toBe(true);
  });

  it("supports the generic divider and keeps its no-connect pad out of the net inventory", async () => {
    const current = await fixture(dividerDraft(), "Create a passive divider candidate.", "divider-clearance");
    const result = await materializeAndReadFreshClearanceEvidence(current.options);

    expect(result.evidence.nets.map((entry) => entry.name)).toEqual(["GND", "VIN", "VOUT"]);
    expect(result.evidence.acceptanceEvidence.netClasses).toEqual([
      { id: "DEFAULT", configuredClearanceMm: 0.2, effectiveClearanceMm: 0.2 },
    ]);
    const project = JSON.parse(await readFile(current.proPath, "utf8")) as {
      net_settings: { classes: { name: string; via_diameter: number; via_drill: number }[]; netclass_assignments: Record<string, string[]> };
    };
    const generated = project.net_settings.classes.find((entry) => entry.name.startsWith("EVLEDA_"));
    expect(generated).toMatchObject({ via_diameter: 0.6, via_drill: 0.3 });
    expect(project.net_settings.netclass_assignments).toEqual({});
  });

  it("uses the larger class for a pair, then the absolute board minimum as the highest floor", async () => {
    const current = await fixture(ledDraft(), "Precedence fixture.", "precedence");
    await materializeFreshNetClasses(current.options);
    const project = JSON.parse(await readFile(current.proPath, "utf8")) as {
      board: { design_settings: { rules: { min_clearance: number } } };
    };
    project.board.design_settings.rules.min_clearance = 0.3;
    await writeFile(current.proPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    const evidence = await readFreshClearanceEvidence(current.options);

    expect(evidence.pairs.every((pair) => pair.effectiveClearanceMm === 0.3)).toBe(true);
    expect(evidence.pairs.every((pair) => pair.limitingSources.includes("board.design_settings.rules.min_clearance"))).toBe(true);
    expect(evidence.acceptanceEvidence.netClasses).toEqual([
      { id: "POWER", configuredClearanceMm: 0.25, effectiveClearanceMm: 0.3 },
      { id: "SIGNAL", configuredClearanceMm: 0.2, effectiveClearanceMm: 0.3 },
    ]);
  });

  it("accepts an empty versioned rule deck but fails closed on every custom rule", async () => {
    const current = await fixture(dividerDraft(), "Custom-rule boundary fixture.", "custom-rules");
    await writeFile(current.druPath, "# no custom rules\n(version 1)\n", "utf8");
    await expect(materializeAndReadFreshClearanceEvidence(current.options)).resolves.toBeDefined();
    const projectBefore = await readFile(current.proPath);

    await writeFile(current.druPath, `(version 1)\n(rule "override" (constraint clearance (min 0.01mm)))\n`, "utf8");
    await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_RULES" });
    await expect(readFile(current.proPath)).resolves.toStrictEqual(projectBefore);

    await writeFile(current.druPath, `(version 1)\n(unknown_rule "adversarial")\n`, "utf8");
    await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_RULES" });
  });

  it("fails closed on zones, every KiCad-10 layered copper graphic, malformed layers, and local overrides", async () => {
    const cases = [
      `(zone (net "GND") (layer "F.Cu") (connect_pads (clearance 0.2)))`,
      `(gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (layer "F.Cu"))`,
      `(image (at 1 1) (layer "F.Cu") (scale 1))`,
      `(barcode "ABC" (at 1 1) (layer "F.Cu"))`,
      `(table (column_count 1) (layer "F.Cu"))`,
      `(dimension (type aligned) (layer "F.Cu"))`,
      `(target plus (at 1 1) (size 1) (width 0.1) (layer "F.Cu"))`,
      `(point (at 1 1) (size 1) (layer "F.Cu"))`,
      `(gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)))`,
      `(gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (layer "F.Cu"))`,
      `(gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (layers "F.Cu"))`,
      `(gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (layers "F.Cu") (layers "B.Cu"))`,
      `(property "Adversarial" "selector" (layer "Edge.Cuts") (layers "F.Cu"))`,
      `(footprint "Test:PropertySelector" (layer "F.Cu") (at 1 1) (property "Reference" "X9" (layer "Edge.Cuts") (layers "F.Cu")) (property "Value" "X") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))`,
      `(gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (layer F.Cu))`,
      `(arc (start 1 1) (mid 2 2) (end 3 1) (width 0.25) (net "VIN"))`,
      `(arc (start 1 1) (mid 2 2) (end 3 1) (width 0.25) (layer "F.Cu") (layers "F.Cu") (net "VIN"))`,
      `(arc (start 1 1) (mid 2 2) (end 3 1) (width 0.25) (layer "F.Cu") (layer "B.Cu") (net "VIN"))`,
      `(via (at 1 1) (size 0.6) (drill 0.3) (net "VIN"))`,
      `(via (at 1 1) (size 0.6) (drill 0.3) (layer "F.Cu") (layers "F.Cu" "B.Cu") (net "VIN"))`,
      `(via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (layers "F.Cu" "B.Cu") (net "VIN"))`,
      `(footprint "Test:MissingPadLayers" (layer "F.Cu") (at 1 1) (property "Reference" "X9") (property "Value" "X") (pad "1" smd rect (at 0 0) (size 1 1) (net "VIN")))`,
      `(footprint "Test:AlternatePadLayer" (layer "F.Cu") (at 1 1) (property "Reference" "X9") (property "Value" "X") (pad "1" smd rect (at 0 0) (size 1 1) (layer "F.Cu") (layers "F.Cu") (net "VIN")))`,
      `(footprint "Test:DuplicatePadLayers" (layer "F.Cu") (at 1 1) (property "Reference" "X9") (property "Value" "X") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (layers "F.Cu") (net "VIN")))`,
      `(future_graphic (layer "Edge.Cuts"))`,
      `(footprint "Test:NestedFuture" (layer "F.Cu") (at 1 1) (property "Reference" "X9") (property "Value" "X") (future_graphic (layer "Edge.Cuts")) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))`,
      `(footprint "Test:Override" (layer "F.Cu") (at 1 1) (clearance 0.1) (property "Reference" "X9") (property "Value" "X") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))`,
      `(footprint "Test:PadOverride" (layer "F.Cu") (at 1 1) (property "Reference" "X9") (property "Value" "X") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (clearance 0)))`,
    ];
    for (const [index, extra] of cases.entries()) {
      const compiled = bundle(dividerDraft(), `Unsupported PCB object ${index}.`);
      const current = await fixture(dividerDraft(), `Unsupported PCB object ${index}.`, `unsupported-${index}`, boardSource(compiled.contract.nets.map((net) => net.name), { extra }));
      await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
    }

    const supported = await fixture(dividerDraft(), "Non-copper graphic fixture.", "non-copper-graphic", boardSource(
      ["VIN", "VOUT", "GND"],
      { extra: `(gr_line (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))` },
    ));
    await expect(materializeAndReadFreshClearanceEvidence(supported.options)).resolves.toBeDefined();

    const routedArc = await fixture(dividerDraft(), "Routed arc fixture.", "routed-arc", boardSource(
      ["VIN", "VOUT", "GND"],
      { extra: `(arc (start 1 1) (mid 2 2) (end 3 1) (width 0.25) (layer "F.Cu") (net "VIN"))` },
    ));
    await expect(materializeAndReadFreshClearanceEvidence(routedArc.options)).resolves.toBeDefined();
  });

  it("authenticates the original closed marker and rejects projectIdentity, file-record, and extra-key tampering", async () => {
    const current = await fixture(dividerDraft(), "Marker closure fixture.", "marker-closure");
    const original = await readFile(current.project.markerPath, "utf8");
    const baseline = JSON.parse(original) as {
      projectIdentity: { canonicalPath: string; dev: string | null; ino: string | null };
      files: Record<string, { path: string; sha256: string }>;
      unexpected?: unknown;
    };
    const variants = [
      () => { const value = structuredClone(baseline); value.projectIdentity.canonicalPath = `${value.projectIdentity.canonicalPath}-other`; return value; },
      () => { const value = structuredClone(baseline); value.files.pro!.sha256 = "f".repeat(64); return value; },
      () => { const value = structuredClone(baseline); (value.files.pro as unknown as Record<string, unknown>).extra = "forged"; return value; },
      () => { const value = structuredClone(baseline); value.unexpected = true; return value; },
    ];
    for (const tampered of variants) {
      await writeFile(current.project.markerPath, `${JSON.stringify(tampered(), null, 2)}\n`, "utf8");
      await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "UNVERIFIED_PROJECT" });
      await writeFile(current.project.markerPath, original, "utf8");
      await expect(current.project.assertMarkerCurrent()).resolves.toEqual(contentIdentity(original));
    }
  });

  it("requires exact net_settings meta version 5 and never overwrites unknown existing schemas", async () => {
    const current = await fixture(dividerDraft(), "Net settings version fixture.", "net-settings-version");
    await materializeFreshNetClasses(current.options);
    const baseline = JSON.parse(await readFile(current.proPath, "utf8")) as {
      net_settings: { meta?: Record<string, unknown> };
    };
    const variants = [
      () => { const value = structuredClone(baseline); value.net_settings.meta = { version: 6 }; return value; },
      () => { const value = structuredClone(baseline); delete value.net_settings.meta; return value; },
      () => { const value = structuredClone(baseline); value.net_settings.meta = { version: 5, future: true }; return value; },
      () => { const value = structuredClone(baseline); value.net_settings.meta = { version: "5" }; return value; },
    ];
    for (const variant of variants) {
      const bytes = `${JSON.stringify(variant(), null, 2)}\n`;
      await writeFile(current.proPath, bytes, "utf8");
      await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "INVALID_PROJECT_JSON" });
      await expect(readFile(current.proPath, "utf8")).resolves.toBe(bytes);
      await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "INVALID_PROJECT_JSON" });
    }
  });

  it("rolls an exact project-settings preimage back after an injected post-commit verification fault", async () => {
    const current = await fixture(dividerDraft(), "Rollback fixture.", "post-commit-rollback");
    const preimage = await readFile(current.proPath);
    process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_POST_COMMIT_FAULT = "throw";
    await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
    await expect(readFile(current.proPath)).resolves.toStrictEqual(preimage);
    await expect(readFile(path.join(current.project.projectPath, ".evleda-fresh-clearance.lock"))).rejects.toMatchObject({ code: "ENOENT" });

    delete process.env.EVLEDA_TEST_ONLY_FRESH_CLEARANCE_POST_COMMIT_FAULT;
    await expect(materializeFreshNetClasses(current.options)).resolves.toMatchObject({ changed: true });
  });

  it("rejects populated derived label caches without trusting even matching class entries", async () => {
    const current = await fixture(ledDraft(), "Assignment tamper fixture.", "assignment-drift");
    await materializeFreshNetClasses(current.options);
    const project = JSON.parse(await readFile(current.proPath, "utf8")) as {
      net_settings: { classes: { name: string }[]; netclass_assignments: Record<string, string[]> };
    };
    const signalClass = (await readFreshNetClassSemanticAuthority(current.options)).contractNetAssignments.find((entry) => entry.netName === "LED_A")!.kicadNetClassName;
    for (const cache of [{ LED_A: [signalClass] }, { LED_A: [signalClass, "Default"] }, { LED_A: ["UNKNOWN"] }, { AUXILIARY: ["Default"] }, { LED_A: [] }]) {
      project.net_settings.netclass_assignments = cache;
      await writeFile(current.proPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
      await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "AMBIGUOUS_RULES" });
      await expect(materializeFreshNetClasses(current.options)).rejects.toMatchObject({ code: "AMBIGUOUS_RULES" });
    }
  });

  it("purely parses closed clearance receipts while reserving source currency for live verification", async () => {
    const current = await fixture(dividerDraft(), "Pure clearance receipt parser fixture.", "pure-receipt-parser");
    await materializeFreshNetClasses(current.options);
    const receipt = await readFreshClearanceEvidence(current.options);
    const parsed = parseFreshClearanceEvidenceReceipt(structuredClone(receipt));
    expect(parsed).toEqual(receipt);
    expect(Object.isFrozen(parsed)).toBe(true);

    const variants: Record<string, unknown>[] = [];
    const tamperedIdentity = structuredClone(receipt) as unknown as Record<string, unknown>;
    (tamperedIdentity.identity as { digest: string }).digest = "0".repeat(64);
    variants.push(tamperedIdentity);
    const wrongSchema = structuredClone(receipt) as unknown as Record<string, unknown>;
    wrongSchema.schemaVersion = "evleda.fresh-clearance-evidence-receipt.v999";
    remintReceiptIdentity(wrongSchema);
    variants.push(wrongSchema);
    const rootPath = structuredClone(receipt) as unknown as Record<string, unknown>;
    rootPath.projectPath = current.project.projectPath;
    remintReceiptIdentity(rootPath);
    variants.push(rootPath);
    const kicadPath = structuredClone(receipt) as unknown as Record<string, unknown>;
    (kicadPath.kicad as Record<string, unknown>).path = "C:/forged/kicad-cli.exe";
    remintReceiptIdentity(kicadPath);
    variants.push(kicadPath);
    const nestedExtra = structuredClone(receipt) as unknown as Record<string, unknown>;
    (((nestedExtra.sourceIdentities as Record<string, unknown>).pcb) as Record<string, unknown>).path = "C:/forged/board.kicad_pcb";
    remintReceiptIdentity(nestedExtra);
    variants.push(nestedExtra);
    for (const variant of variants) {
      expect(() => parseFreshClearanceEvidenceReceipt(variant)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }

    const replacementPcbIdentity = contentIdentity("structurally coherent substituted PCB bytes");
    const incoherent = structuredClone(receipt) as unknown as Record<string, unknown>;
    (incoherent.sourceIdentities as Record<string, unknown>).pcb = replacementPcbIdentity;
    (incoherent.acceptanceEvidence as Record<string, unknown>).pcbSha256 = replacementPcbIdentity.digest;
    remintReceiptIdentity(incoherent);
    expect(() => parseFreshClearanceEvidenceReceipt(incoherent)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const coherent = structuredClone(receipt) as unknown as Record<string, unknown>;
    const sources = coherent.sourceIdentities as Record<string, unknown>;
    const acceptance = coherent.acceptanceEvidence as Record<string, unknown>;
    sources.pcb = replacementPcbIdentity;
    acceptance.pcbSha256 = replacementPcbIdentity.digest;
    sources.ruleSourceSet = canonicalIdentity({
      schemaVersion: FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION,
      projectSettings: sources.projectSettings,
      customRules: sources.customRules,
      pcb: sources.pcb,
      kicad: coherent.kicad,
      resolution: coherent.ruleResolution,
    }, FRESH_CLEARANCE_RULE_SOURCE_SET_SCHEMA_VERSION);
    acceptance.rulesSourceSha256 = (sources.ruleSourceSet as { digest: string }).digest;
    remintReceiptIdentity(coherent);
    expect(parseFreshClearanceEvidenceReceipt(coherent)).toEqual(coherent);
    await expect(verifyFreshClearanceEvidenceReceipt(coherent, current.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
  });

  it("purely cross-validates final receipt semantics against the approved pre-authoring authority", async () => {
    const current = await fixture(dividerDraft(), "Receipt semantic cross-link fixture.", "receipt-semantic-cross-link");
    await materializeFreshNetClasses(current.options);
    const authority = await readFreshNetClassSemanticAuthority(current.options);
    const receipt = await readFreshClearanceEvidence(current.options);

    const parsedAuthority = parseFreshNetClassSemanticAuthority(structuredClone(authority));
    expect(parsedAuthority).toEqual(authority);
    expect(Object.isFrozen(parsedAuthority)).toBe(true);
    expect(verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority(receipt, authority)).toEqual(receipt);

    const widthRemint = structuredClone(receipt) as unknown as Record<string, unknown>;
    (widthRemint.netClasses as Record<string, unknown>[])[0]!.traceWidthMm = 0.5;
    remintReceiptIdentity(widthRemint);
    expect(parseFreshClearanceEvidenceReceipt(widthRemint)).toEqual(widthRemint);
    expect(() => verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority(widthRemint, authority)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const clearanceRemint = structuredClone(receipt) as unknown as Record<string, unknown>;
    (clearanceRemint.netClasses as Record<string, unknown>[])[0]!.configuredClearanceMm = 0.3;
    for (const net of clearanceRemint.nets as Record<string, unknown>[]) {
      net.configuredClearanceMm = 0.3;
      net.effectiveClearanceMm = 0.3;
    }
    for (const pair of clearanceRemint.pairs as Record<string, unknown>[]) pair.effectiveClearanceMm = 0.3;
    const clearanceAcceptance = (clearanceRemint.acceptanceEvidence as { netClasses: Record<string, unknown>[] }).netClasses[0]!;
    clearanceAcceptance.configuredClearanceMm = 0.3;
    clearanceAcceptance.effectiveClearanceMm = 0.3;
    remintReceiptIdentity(clearanceRemint);
    expect(parseFreshClearanceEvidenceReceipt(clearanceRemint)).toEqual(clearanceRemint);
    expect(() => verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority(clearanceRemint, authority)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const boardMinimumRemint = structuredClone(receipt) as unknown as Record<string, unknown>;
    boardMinimumRemint.boardMinimumClearanceMm = 0.3;
    for (const net of boardMinimumRemint.nets as Record<string, unknown>[]) net.effectiveClearanceMm = 0.3;
    for (const pair of boardMinimumRemint.pairs as Record<string, unknown>[]) {
      pair.effectiveClearanceMm = 0.3;
      pair.limitingSources = ["board.design_settings.rules.min_clearance"];
    }
    (boardMinimumRemint.acceptanceEvidence as { netClasses: Record<string, unknown>[] }).netClasses[0]!.effectiveClearanceMm = 0.3;
    remintReceiptIdentity(boardMinimumRemint);
    expect(parseFreshClearanceEvidenceReceipt(boardMinimumRemint)).toEqual(boardMinimumRemint);
    expect(() => verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority(boardMinimumRemint, authority)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const assignmentRemint = structuredClone(receipt) as unknown as Record<string, unknown>;
    const assignmentClasses = assignmentRemint.netClasses as { netNames: string[] }[];
    assignmentClasses[0]!.netNames[0] = "AAA";
    const assignmentNets = assignmentRemint.nets as { name: string }[];
    assignmentNets[0]!.name = "AAA";
    for (const pair of assignmentRemint.pairs as { leftNet: string; rightNet: string }[]) {
      if (pair.leftNet === "GND") pair.leftNet = "AAA";
      if (pair.rightNet === "GND") pair.rightNet = "AAA";
    }
    remintReceiptIdentity(assignmentRemint);
    expect(parseFreshClearanceEvidenceReceipt(assignmentRemint)).toEqual(assignmentRemint);
    expect(() => verifyFreshClearanceEvidenceReceiptAgainstSemanticAuthority(assignmentRemint, authority)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const extraAuthority = structuredClone(authority) as unknown as Record<string, unknown>;
    extraAuthority.projectPath = current.project.projectPath;
    remintIdentity(extraAuthority, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    expect(() => parseFreshNetClassSemanticAuthority(extraAuthority)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const splitManagedClass = structuredClone(authority) as unknown as Record<string, unknown>;
    (splitManagedClass.contractNetAssignments as Record<string, unknown>[])[1]!.contractNetClassId = "OTHER";
    remintIdentity(splitManagedClass, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    expect(() => parseFreshNetClassSemanticAuthority(splitManagedClass)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("requires a used one-to-one managed/contract class mapping while allowing multiple nets per class", async () => {
    const current = await fixture(ledDraft(), "Semantic class bijection fixture.", "semantic-class-bijection");
    await materializeFreshNetClasses(current.options);
    const authority = await readFreshNetClassSemanticAuthority(current.options);
    const powerClassName = authority.netClasses[0]!.name;
    expect(authority.contractNetAssignments.filter((entry) => entry.kicadNetClassName === powerClassName)).toHaveLength(2);
    expect(authority.netClasses.map((netClass) =>
      authority.contractNetAssignments.find((entry) => entry.kicadNetClassName === netClass.name)!.contractNetClassId)).toEqual(["POWER", "SIGNAL"]);
    expect(parseFreshNetClassSemanticAuthority(authority)).toEqual(authority);

    const unusedManagedClass = structuredClone(authority) as unknown as Record<string, unknown>;
    const secondManagedName = (unusedManagedClass.netClasses as { name: string }[])[1]!.name;
    unusedManagedClass.contractNetAssignments = (unusedManagedClass.contractNetAssignments as { kicadNetClassName: string }[])
      .filter((entry) => entry.kicadNetClassName !== secondManagedName);
    remintIdentity(unusedManagedClass, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    expect(() => parseFreshNetClassSemanticAuthority(unusedManagedClass)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const sharedContractClass = structuredClone(authority) as unknown as Record<string, unknown>;
    const assignments = sharedContractClass.contractNetAssignments as Record<string, unknown>[];
    const firstContractClassId = assignments.find((entry) => entry.kicadNetClassName === powerClassName)!.contractNetClassId;
    for (const assignment of assignments) {
      if (assignment.kicadNetClassName === secondManagedName) assignment.contractNetClassId = firstContractClassId;
    }
    remintIdentity(sharedContractClass, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    expect(() => parseFreshNetClassSemanticAuthority(sharedContractClass)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const reversedContractClasses = structuredClone(authority) as unknown as Record<string, unknown>;
    const reversedAssignments = reversedContractClasses.contractNetAssignments as Record<string, unknown>[];
    for (const assignment of reversedAssignments) {
      assignment.contractNetClassId = assignment.kicadNetClassName === powerClassName ? "SIGNAL" : "POWER";
    }
    remintIdentity(reversedContractClasses, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
    expect(() => parseFreshNetClassSemanticAuthority(reversedContractClasses)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("enforces exact source identity size ceilings while accepting every ceiling boundary", async () => {
    const current = await fixture(dividerDraft(), "Receipt source-size bounds fixture.", "receipt-source-bounds");
    await materializeFreshNetClasses(current.options);
    const receipt = await readFreshClearanceEvidence(current.options);
    const boundary = structuredClone(receipt) as unknown as Record<string, unknown>;
    const boundarySources = boundary.sourceIdentities as Record<string, unknown>;
    (boundary.freshMarkerContentIdentity as { size: number }).size = FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumMarkerBytes;
    (boundarySources.projectSettings as { size: number }).size = FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumProjectBytes;
    (boundarySources.pcb as { size: number }).size = FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumPcbBytes;
    boundarySources.customRules = {
      algorithm: "sha256",
      digest: "e".repeat(64),
      size: FRESH_CLEARANCE_EVIDENCE_LIMITS.maximumRulesBytes,
    };
    remintReceiptSourceSet(boundary);
    expect(parseFreshClearanceEvidenceReceipt(boundary)).toEqual(boundary);

    const overflowVariants = [
      () => {
        const value = structuredClone(boundary) as Record<string, unknown>;
        ((value.sourceIdentities as Record<string, unknown>).projectSettings as { size: number }).size += 1;
        return value;
      },
      () => {
        const value = structuredClone(boundary) as Record<string, unknown>;
        ((value.sourceIdentities as Record<string, unknown>).pcb as { size: number }).size += 1;
        return value;
      },
      () => {
        const value = structuredClone(boundary) as Record<string, unknown>;
        ((value.sourceIdentities as Record<string, unknown>).customRules as { size: number }).size += 1;
        return value;
      },
      () => {
        const value = structuredClone(boundary) as Record<string, unknown>;
        (value.freshMarkerContentIdentity as { size: number }).size += 1;
        return value;
      },
    ];
    for (const variant of overflowVariants) {
      const value = variant();
      remintReceiptSourceSet(value);
      expect(() => parseFreshClearanceEvidenceReceipt(value)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });

  it("rejects coherently reminted class names, oversized rules, and path-bearing KiCad capabilities", async () => {
    const current = await fixture(dividerDraft(), "Receipt semantic bounds fixture.", "receipt-semantic-bounds");
    await materializeFreshNetClasses(current.options);
    const receipt = await readFreshClearanceEvidence(current.options);

    for (const suffix of ["EVLEDA_ffffffffffff_C01", `EVLEDA_${receipt.bundleIdentity.digest.slice(0, 12)}_C02`]) {
      const value = structuredClone(receipt) as unknown as Record<string, unknown>;
      const classes = value.netClasses as Record<string, unknown>[];
      const nets = value.nets as Record<string, unknown>[];
      classes[0]!.kicadNetClassName = suffix;
      for (const net of nets) net.kicadNetClassName = suffix;
      remintReceiptIdentity(value);
      expect(() => parseFreshClearanceEvidenceReceipt(value)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }

    const numericBoundary = structuredClone(receipt) as unknown as Record<string, unknown>;
    const boundaryClasses = numericBoundary.netClasses as Record<string, unknown>[];
    const boundaryNets = numericBoundary.nets as Record<string, unknown>[];
    const boundaryPairs = numericBoundary.pairs as Record<string, unknown>[];
    const boundaryAcceptance = (numericBoundary.acceptanceEvidence as { netClasses: Record<string, unknown>[] }).netClasses;
    boundaryClasses[0]!.traceWidthMm = 20;
    boundaryClasses[0]!.configuredClearanceMm = 10;
    for (const net of boundaryNets) {
      net.configuredClearanceMm = 10;
      net.effectiveClearanceMm = 10;
    }
    for (const pair of boundaryPairs) pair.effectiveClearanceMm = 10;
    boundaryAcceptance[0]!.configuredClearanceMm = 10;
    boundaryAcceptance[0]!.effectiveClearanceMm = 10;
    remintReceiptIdentity(numericBoundary);
    expect(parseFreshClearanceEvidenceReceipt(numericBoundary)).toEqual(numericBoundary);

    const oversized = structuredClone(numericBoundary) as Record<string, unknown>;
    const oversizedClasses = oversized.netClasses as Record<string, unknown>[];
    const oversizedNets = oversized.nets as Record<string, unknown>[];
    const oversizedPairs = oversized.pairs as Record<string, unknown>[];
    const oversizedAcceptance = (oversized.acceptanceEvidence as { netClasses: Record<string, unknown>[] }).netClasses;
    oversizedClasses[0]!.traceWidthMm = 500;
    oversizedClasses[0]!.configuredClearanceMm = 500;
    for (const net of oversizedNets) {
      net.configuredClearanceMm = 500;
      net.effectiveClearanceMm = 500;
    }
    for (const pair of oversizedPairs) pair.effectiveClearanceMm = 500;
    oversizedAcceptance[0]!.configuredClearanceMm = 500;
    oversizedAcceptance[0]!.effectiveClearanceMm = 500;
    remintReceiptIdentity(oversized);
    expect(() => parseFreshClearanceEvidenceReceipt(oversized)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const pathCapability = structuredClone(receipt) as unknown as Record<string, unknown>;
    (pathCapability.kicad as Record<string, unknown>).confirmedCapabilities = ["C:/secret/private/kicad.exe"];
    remintReceiptSourceSet(pathCapability);
    expect(() => parseFreshClearanceEvidenceReceipt(pathCapability)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("enforces contract class/net/pair limits and exact reserved-name parity", async () => {
    const current = await fixture(dividerDraft(), "Receipt inventory bounds fixture.", "receipt-inventory-bounds");
    await materializeFreshNetClasses(current.options);
    const receipt = await readFreshClearanceEvidence(current.options);

    const thirtyTwoClasses = syntheticClearanceReceipt(receipt, 32, 32);
    expect(parseFreshClearanceEvidenceReceipt(thirtyTwoClasses)).toEqual(thirtyTwoClasses);
    const thirtyThreeClasses = syntheticClearanceReceipt(receipt, 33, 33);
    expect(() => parseFreshClearanceEvidenceReceipt(thirtyThreeClasses)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const oneHundredTwentyEightNets = syntheticClearanceReceipt(receipt, 1, 128);
    expect((oneHundredTwentyEightNets.pairs as unknown[]).length).toBe((128 * 127) / 2);
    expect(parseFreshClearanceEvidenceReceipt(oneHundredTwentyEightNets)).toEqual(oneHundredTwentyEightNets);
    const oneHundredTwentyNineNets = syntheticClearanceReceipt(receipt, 1, 129);
    expect(() => parseFreshClearanceEvidenceReceipt(oneHundredTwentyNineNets)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    const incompletePairs = syntheticClearanceReceipt(receipt, 1, 3);
    (incompletePairs.pairs as unknown[]).pop();
    remintReceiptIdentity(incompletePairs);
    expect(() => parseFreshClearanceEvidenceReceipt(incompletePairs)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    for (const reservedName of ["__proto__", "constructor", "prototype"]) {
      const reserved = syntheticClearanceReceipt(receipt, 1, 1);
      ((reserved.netClasses as { netNames: string[] }[])[0]!).netNames = [reservedName];
      ((reserved.nets as { name: string }[])[0]!).name = reservedName;
      remintReceiptIdentity(reserved);
      expect(() => parseFreshClearanceEvidenceReceipt(reserved)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });

  it("detects receipt tampering, reminted claims, bundle forgery, and post-capture source drift", async () => {
    const current = await fixture(dividerDraft(), "Tamper fixture.", "tamper");
    await materializeFreshNetClasses(current.options);
    const receipt = await readFreshClearanceEvidence(current.options);

    const tampered = structuredClone(receipt) as unknown as Record<string, unknown>;
    const acceptance = tampered.acceptanceEvidence as { netClasses: { effectiveClearanceMm: number }[] };
    acceptance.netClasses[0]!.effectiveClearanceMm = 99;
    await expect(verifyFreshClearanceEvidenceReceipt(tampered, current.options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    remintReceiptIdentity(tampered);
    await expect(verifyFreshClearanceEvidenceReceipt(tampered, current.options)).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const forgedBundle = structuredClone(current.bundle) as unknown as PcbDesignCompilationBundle;
    const forgedOptions = { ...current.options, compilationBundle: forgedBundle };
    await expect(readFreshClearanceEvidence(forgedOptions)).rejects.toMatchObject({ code: "UNVERIFIED_BUNDLE" });

    await writeFile(current.pcbPath, `${await readFile(current.pcbPath, "utf8")}\n`, "utf8");
    await expect(verifyFreshClearanceEvidenceReceipt(receipt, current.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
  });

  it("rejects source net drift and adversarial S-expression ambiguity", async () => {
    const current = await fixture(dividerDraft(), "S-expression fixture.", "sexpr");
    await materializeFreshNetClasses(current.options);
    await writeFile(current.pcbPath, boardSource(["VIN", "VOUT", "GND", "EXTRA"]), "utf8");
    await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNASSIGNED_NET" });

    await writeFile(current.pcbPath, `${boardSource(["VIN", "VOUT", "GND"])}(kicad_pcb)`, "utf8");
    await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });

    await writeFile(current.pcbPath, boardSource(["VIN", "VOUT", "GND"]).replace('"GND"', '"GND)'), "utf8");
    await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });

    const deep = `(kicad_pcb (version 20250316) ${"(x ".repeat(257)}y${")".repeat(257)})`;
    await writeFile(current.pcbPath, deep, "utf8");
    await expect(readFreshClearanceEvidence(current.options)).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
  });

  it("rejects duplicate-key JSON while preserving a literal __proto__ member without prototype pollution", async () => {
    const duplicate = await fixture(dividerDraft(), "Duplicate JSON fixture.", "duplicate-json");
    const original = await readFile(duplicate.proPath, "utf8");
    const duplicateText = original.replace(/^\{/u, `{\n  "board": {"file":"duplicate-json.kicad_pcb"},`);
    await writeFile(duplicate.proPath, duplicateText, "utf8");
    await expect(materializeFreshNetClasses(duplicate.options)).rejects.toMatchObject({ code: "INVALID_PROJECT_JSON" });

    const proto = await fixture(dividerDraft(), "Proto JSON fixture.", "proto-json");
    const parsed = JSON.parse(await readFile(proto.proPath, "utf8")) as Record<string, unknown>;
    Object.defineProperty(parsed, "__proto__", { value: { retained: "literal" }, enumerable: true, configurable: true, writable: true });
    await writeFile(proto.proPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await materializeFreshNetClasses(proto.options);
    const after = JSON.parse(await readFile(proto.proPath, "utf8")) as Record<string, unknown>;
    expect(Object.prototype).not.toHaveProperty("retained");
    expect(Object.getOwnPropertyDescriptor(after, "__proto__")?.value).toEqual({ retained: "literal" });
  });

  it.runIf(process.env.EVLEDA_RUN_KICAD10_CLEARANCE_FIXTURE === "1")(
    "loads the materialized project through the installed headless KiCad 10 DRC parser without using DRC as evidence",
    async () => {
      const executable = process.env.EVLEDA_KICAD_CLI ?? "D:\\Codex-Recovery\\KiCad\\10.0\\bin\\kicad-cli.exe";
      const [{ stdout: versionOutput }, { stdout: commitOutput }] = await Promise.all([
        execFile(executable, ["--version"]),
        execFile(executable, ["version", "--format", "commit"]),
      ]);
      const executableBytes = await readFile(executable);
      const actualIdentity: KicadExecutableIdentity = {
        kind: "kicad-cli",
        path: executable,
        version: versionOutput.trim(),
        commit: commitOutput.trim(),
        sha256: createHash("sha256").update(executableBytes).digest("hex"),
        sizeBytes: executableBytes.byteLength,
        capabilityHelpSha256: contentIdentity("opt-in pcb drc parser probe").digest,
        confirmedCapabilities: ["pcb drc"],
      };
      const current = await fixture(dividerDraft(), "Headless KiCad parser fixture.", "headless-kicad");
      const options = { ...current.options, kicad: actualIdentity };
      await materializeFreshNetClasses(options);
      const materializedProject = JSON.parse(await readFile(current.proPath, "utf8")) as {
        net_settings: { meta: { version: number }; classes: { name: string; clearance: number }[]; netclass_assignments: Record<string, string[]> };
      };
      expect(materializedProject.net_settings.meta).toEqual({ version: 5 });
      expect(materializedProject.net_settings.classes.filter((entry) => entry.name.startsWith("EVLEDA_")).map((entry) => entry.clearance)).toEqual([0.2]);
      expect(materializedProject.net_settings.netclass_assignments).toEqual({});
      const report = path.join(current.project.projectPath, "headless-drc.json");
      await execFile(executable, ["pcb", "drc", "--format", "json", "--output", report, current.pcbPath], {
        cwd: current.project.projectPath,
        maxBuffer: 4 * 1024 * 1024,
      });
      await expect(readFile(report, "utf8")).resolves.toContain('"coordinate_units"');
      const pcbHelp = await execFile(executable, ["pcb", "--help"]);
      expect(`${pcbHelp.stdout}\n${pcbHelp.stderr}`).not.toMatch(/net.?class|constraint.?resolution|inspect.?rules/iu);
      const evidence = await readFreshClearanceEvidence(options);
      expect(evidence.evidenceLimitations[0]).toMatch(/not a DRC result/i);
      expect(evidence.evidenceLimitations).toContainEqual(expect.stringMatching(/no net-class.*inspection command/i));
      expect(evidence.acceptanceEvidence.netClasses).toEqual([
        { id: "DEFAULT", configuredClearanceMm: 0.2, effectiveClearanceMm: 0.2 },
      ]);
      expect(evidence).not.toHaveProperty("drc");
    },
    120_000,
  );
});

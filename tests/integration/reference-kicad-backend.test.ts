import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { parseRequirements } from "../../src/core/requirements.js";
import type { CanonicalIdentity } from "../../src/domain/types.js";
import {
  configuredKicadCliPath,
  KicadCliAdapter,
  REFERENCE_KICAD_BACKEND_ID,
  REFERENCE_KICAD_CAM_SCHEMA,
  REFERENCE_KICAD_GENERATOR_INPUT_PATHS,
  REFERENCE_KICAD_REPORT_SCHEMA,
  REFERENCE_KICAD_REPLAY_SCRIPT_PATHS,
  REFERENCE_KICAD_REQUEST_BINDING_SCHEMA,
  REFERENCE_KICAD_REQUIRED_NETS,
  REFERENCE_KICAD_VERSION,
  REFERENCE_VALIDATION_SCHEMA,
  ReferenceKicadBackend,
  ReferenceKicadBackendError,
  deriveReferenceFirmwareParityFromNetlist,
  referenceKicadRequestBinding,
} from "../../src/integrations/index.js";
import { firmwareParityMappingModel } from "../../src/knowledge/firmware-parity-model.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
  REFERENCE_CONTROLLER_REV_A_MCU_REFERENCE,
  ReferenceControllerNativeContractError,
} from "../../src/knowledge/reference-controller-native-contract.js";
import * as nativeContractAuthority from "../../src/knowledge/reference-controller-native-contract.js";
import {
  buildPcbPracticeAnalysisProfile,
} from "../../src/generators/pcb-generator.js";
import {
  PCB_LAYOUT_QUALITY_POLICY,
  PCB_ROUTE_QUALITY_RULE_DECK,
  REV_A_PROOF_FIXTURE_POLICY,
  buildPcbLayoutPlan,
} from "../../src/generators/pcb-layout-plan.js";
import { PCB_ENGINEERING_PRACTICE_CATALOG } from "../../src/knowledge/pcb-engineering-practices.js";
import {
  createReferenceControllerProfile,
  REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
  REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
  ROBOTICS_CONTROLLER_V0,
  type ReferenceControllerProfile,
} from "../../src/knowledge/reference-controller-v0.js";
import type {
  KicadBackendRequest,
  KicadBackendResult,
  KicadBackendStage,
} from "../../src/workflow/contracts.js";

const REFERENCE_ROOT = path.resolve("reference-designs", "robotics-controller-v0");
const TEST_KICAD_CLI_PATH = configuredKicadCliPath();
const VALIDATION_MANIFEST = path.join(
  REFERENCE_ROOT,
  "validation",
  "reference-validation.json",
);
const SOURCE_DIGEST = "7a00f937bfb15668ed437b5d79c5391c6065dd6008ad4aa2d332f56527ca51f8";
const PROMPT = [
  "Build a two-channel brushed motor controller for a 7-16.8 V DC supply.",
  "Each motor is limited to 0.5 A RMS with USB, CAN, UART, I2C, SPI,",
  "two quadrature encoders, and SWD programming.",
].join(" ");
const NARROW_PROFILE = createReferenceControllerProfile({
  inputVoltageMv: { minimum: 9_000, maximum: 12_000 },
  motor: {
    channels: 2,
    rmsCurrentMaPerChannel: 250,
    currentChopMaPerChannel: 1_000,
  },
});
const NARROW_PROMPT = [
  "Build a two-channel brushed motor controller for a 9-12 V DC supply.",
  "Each motor is limited to 0.25 A RMS with USB, CAN, UART, I2C, SPI,",
  "two quadrature encoders, and SWD programming.",
].join(" ");

const temporaryRoots: string[] = [];

function firmwareParityNetlist(wrongSignal?: string): Uint8Array {
  const model = firmwareParityMappingModel(ROBOTICS_CONTROLLER_V0);
  const netNames = new Set<string>(REFERENCE_KICAD_REQUIRED_NETS);
  for (const pin of model.pins) if (pin.nativeNetName !== null) netNames.add(pin.nativeNetName);
  if (wrongSignal !== undefined) netNames.add("WRONG_NATIVE_NET");
  const nets = [...netNames].sort().map((netName, index) => {
    const nodes = model.pins
      .filter((pin) => pin.nativeNetName === netName || (pin.signal === wrongSignal && netName === "WRONG_NATIVE_NET"))
      .filter((pin) => !(pin.signal === wrongSignal && pin.nativeNetName === netName))
      .map((pin) => `(node (ref "${pin.reference}") (pin "${pin.physicalPin}") (pinfunction "${pin.expectedPinFunction}") (pintype "bidirectional"))`)
      .join(" ");
    return `(net (code "${index + 1}") (name "${netName}") ${nodes})`;
  });
  return Buffer.from(
    `(export (components (comp (ref ${JSON.stringify(REFERENCE_CONTROLLER_REV_A_MCU_REFERENCE)}))) (nets ${nets.join(" ")}))`,
    "utf8",
  );
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryRoots.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function requestFor(
  stage: KicadBackendStage,
  profile: ReferenceControllerProfile = ROBOTICS_CONTROLLER_V0,
  prompt = PROMPT,
): KicadBackendRequest {
  const plan = buildPcbLayoutPlan(profile);
  const analyzerProfile = buildPcbPracticeAnalysisProfile(profile, plan);
  const snapshot = <T,>(logicalName: string, document: T, identity: CanonicalIdentity) => ({
    logicalName,
    document,
    contentIdentity: contentIdentity(`${canonicalJson(document)}\n`),
    canonicalIdentity: identity,
  });
  return {
    schemaVersion: "evleda.kicad-request.v2",
    stage,
    expectedSourceRevisionDigest: SOURCE_DIGEST,
    profile,
    requirements: parseRequirements(prompt).document,
    upstreamArtifactIdentities: [
      contentIdentity("system-architecture"),
      contentIdentity("component-selection"),
    ],
    pcbEngineering:
      stage === "pcb_placement_routing"
        ? {
            layoutPlan: {
              logicalName: "pcb/layout-routing-plan.json",
              document: plan,
              contentIdentity: contentIdentity(`${canonicalJson(plan)}\n`),
            },
            analyzerProfile: snapshot(
              "pcb/engineering/analyzer-profile.json",
              analyzerProfile,
              canonicalIdentity(analyzerProfile, analyzerProfile.schemaVersion),
            ),
            practiceCatalog: snapshot(
              "pcb/engineering/practice-catalog.json",
              PCB_ENGINEERING_PRACTICE_CATALOG,
              PCB_ENGINEERING_PRACTICE_CATALOG.identity,
            ),
            routeQualityPolicy: {
              ...snapshot(
                "pcb/engineering/route-quality-policy.json",
                PCB_LAYOUT_QUALITY_POLICY,
                PCB_LAYOUT_QUALITY_POLICY.identity,
              ),
              captureIdentity: PCB_LAYOUT_QUALITY_POLICY.captureIdentity,
            },
            routeQualityRuleDeck: snapshot(
              "pcb/engineering/route-quality-rule-deck.json",
              PCB_ROUTE_QUALITY_RULE_DECK,
              PCB_ROUTE_QUALITY_RULE_DECK.identity,
            ),
            proofFixturePolicy: snapshot(
              "pcb/engineering/proof-fixture-policy.json",
              REV_A_PROOF_FIXTURE_POLICY,
              REV_A_PROOF_FIXTURE_POLICY.identity,
            ),
            engineeringConstraintBinding: null,
          }
        : null,
  };
}

function decodeJson(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as Readonly<Record<string, unknown>>;
}

function reportDocuments(result: KicadBackendResult): readonly Readonly<Record<string, unknown>>[] {
  return result.reports
    .filter((report) => report.evidenceClass === "evleda_check")
    .map((report) => decodeJson(report.content));
}

interface TestBinding {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

const SYNTHETIC_SOURCE_PATHS = [
  "fp-lib-table",
  "footprints/robotics_edge.pretty/C26_Edge.kicad_mod",
  "footprints/robotics_edge.pretty/J1_Edge.kicad_mod",
  "footprints/robotics_edge.pretty/J4_Edge.kicad_mod",
  "footprints/robotics_edge.pretty/J5_Edge.kicad_mod",
  "footprints/robotics_edge.pretty/J6_Edge.kicad_mod",
  "footprints/robotics_edge.pretty/J8_Edge.kicad_mod",
  "footprints/robotics_edge.pretty/JP1_Edge.kicad_mod",
  "robotics-controller-v0.kicad_dru",
  "robotics-controller-v0.kicad_pcb",
  "robotics-controller-v0.kicad_pro",
  "robotics-controller-v0.kicad_sch",
  "sym-lib-table",
  "symbols/robotics_drv8874.kicad_sym",
  "symbols/robotics_lmr51420.kicad_sym",
  "symbols/robotics_sn74lvc2g17.kicad_sym",
  "symbols/robotics_tcan3413.kicad_sym",
  "symbols/robotics_tps2553.kicad_sym",
  "symbols/robotics_usb_c.kicad_sym",
  "symbols/robotics_usblc6.kicad_sym",
] as const;

const VALIDATION_COMMANDS = [
  ["00-version", ["version"]],
  ["01-commit", ["version", "--format", "commit"]],
  ["help-01", ["sch", "erc", "--help"]],
  ["help-02", ["pcb", "drc", "--help"]],
  ["help-03", ["sch", "export", "netlist", "--help"]],
  ["help-04", ["pcb", "export", "stats", "--help"]],
  ["help-05", ["pcb", "export", "ipcd356", "--help"]],
  ["help-06", ["sch", "export", "pdf", "--help"]],
  ["help-07", ["sch", "export", "bom", "--help"]],
  ["help-08", ["sch", "export", "svg", "--help"]],
  ["help-09", ["pcb", "export", "gerbers", "--help"]],
  ["help-10", ["pcb", "export", "drill", "--help"]],
  ["help-11", ["pcb", "export", "pos", "--help"]],
  ["help-12", ["pcb", "render", "--help"]],
  ["10-erc", ["sch", "erc"]],
  ["11-drc-parity", ["pcb", "drc"]],
  ["20-bom", ["sch", "export", "bom"]],
  ["21-netlist", ["sch", "export", "netlist"]],
  ["22-schematic-svg", ["sch", "export", "svg"]],
  ["23-schematic-pdf", ["sch", "export", "pdf"]],
  ["30-gerbers", ["pcb", "export", "gerbers"]],
  ["31-drill", ["pcb", "export", "drill"]],
  ["32-position", ["pcb", "export", "pos"]],
  ["33-render-top", ["pcb", "render"]],
  ["34-render-bottom", ["pcb", "render"]],
  ["35-board-stats", ["pcb", "export", "stats"]],
  ["36-board-ipcd356", ["pcb", "export", "ipcd356"]],
  ["37-board-svg-top", ["pcb", "export", "svg"]],
  ["38-board-svg-bottom", ["pcb", "export", "svg"]],
] as const;

async function syntheticPassingReference(options: {
  readonly omitRequiredNet?: boolean;
  readonly addUnknownNetlistNodeReference?: boolean;
  readonly swapSelectedRoleReferences?: boolean;
  readonly omitPositionReference?: boolean;
  readonly addUnexpectedPositionReference?: boolean;
  readonly duplicatePositionReference?: boolean;
  readonly unterminatedPositionCsv?: boolean;
  readonly invalidPositionQuote?: "mid_field" | "trailing_data";
  readonly positionExclusionReason?: "dnp" | "exclude_from_pos_files";
  readonly positionCommandExcludeDnp?: boolean;
  readonly generatorBoardDigestMismatch?: boolean;
  readonly generatorTrackCountMismatch?: boolean;
  readonly omitFootprintDeclaration?: boolean;
  readonly mutateRegenerationEvidence?: (evidence: Record<string, unknown>) => void;
  readonly mutateConnectivity?: (connectivity: Record<string, unknown>) => void;
  readonly mutateManifest?: (manifest: Record<string, unknown>) => void;
} = {}): Promise<{
  readonly referenceRoot: string;
  readonly workRoot: string;
  readonly unexpectedReference: string;
  readonly positionMutationReference: string;
}> {
  const fixtureRoot = await temporaryDirectory("evleda-reference-backend-strict-");
  const referenceRoot = path.join(fixtureRoot, "reference");
  const workRoot = path.join(fixtureRoot, "work");
  const runId = "20260903T000000.000000Z-0000000000000000";
  const runRoot = `validation/runs/${runId}`;
  await Promise.all([mkdir(referenceRoot), mkdir(workRoot)]);

  const writeBound = async (logicalPath: string, content: string): Promise<TestBinding> => {
    const bytes = Buffer.from(content, "utf8");
    const target = path.join(referenceRoot, ...logicalPath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    const identity = contentIdentity(bytes);
    return { path: logicalPath, sizeBytes: identity.size, sha256: identity.digest };
  };
  const writeJson = async (logicalPath: string, value: unknown): Promise<TestBinding> =>
    await writeBound(logicalPath, canonicalJson(value));

  const canonicalSelectedComponents = ROBOTICS_CONTROLLER_V0.components.flatMap((component) =>
    REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators[component.key].map(
      (reference) => ({
        reference,
        value: component.partNumber,
        footprint: component.footprint,
        partNumber: component.partNumber,
      }),
    ),
  );
  const swappedReference = new Map<string, string>([
    ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.motor_driver.map(
      (reference, index) => [
        reference,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.encoder_buffer[index]!,
      ] as const,
    ),
    ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.encoder_buffer.map(
      (reference, index) => [
        reference,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.motor_driver[index]!,
      ] as const,
    ),
  ]);
  const selectedComponents = canonicalSelectedComponents.map((component) => ({
    ...component,
    reference:
      options.swapSelectedRoleReferences === true
        ? swappedReference.get(component.reference) ?? component.reference
        : component.reference,
  }));
  const parsedSelectedReferences = selectedComponents.map((component) => {
    const match = /^(?<prefix>[A-Za-z]+)(?<number>\d+)$/u.exec(component.reference);
    if (match?.groups?.prefix === undefined || match.groups.number === undefined) {
      throw new Error("Synthetic selected-component references must have a shared alpha-numeric form.");
    }
    return { prefix: match.groups.prefix, number: Number(match.groups.number) };
  });
  const referencePrefixes = new Set(parsedSelectedReferences.map((entry) => entry.prefix));
  if (referencePrefixes.size !== 1) {
    throw new Error("Synthetic selected-component references must have one prefix.");
  }
  const unexpectedReference = `${parsedSelectedReferences[0]!.prefix}${
    Math.max(...parsedSelectedReferences.map((entry) => entry.number)) + 1
  }`;
  const positionMutationReference = selectedComponents[0]!.reference;
  const positionCommandExcludeDnp = options.positionCommandExcludeDnp ?? true;
  const deliberatelyExcludedPositionReference =
    options.positionExclusionReason === undefined
      ? undefined
      : positionMutationReference;
  const syntheticBoard = [
    "(kicad_pcb",
    ...selectedComponents.map((component) => [
      `  (footprint ${JSON.stringify(component.footprint)}`,
      `    (property \"Reference\" ${JSON.stringify(component.reference)})`,
      `    (property \"Value\" ${JSON.stringify(component.value)})`,
      `    (property \"MPN\" ${JSON.stringify(component.partNumber)})`,
      `    (attr smd${
        component.reference === deliberatelyExcludedPositionReference
          ? ` ${options.positionExclusionReason}`
          : ""
      })`,
      "  )",
    ].join("\n")),
    ")",
    "",
  ].join("\n");
  const syntheticNetlist = [
    "(export",
    "  (components",
    ...selectedComponents.map((component) => [
      "    (comp",
      `      (ref ${JSON.stringify(component.reference)})`,
      `      (value ${JSON.stringify(component.value)})`,
      `      (footprint ${JSON.stringify(component.footprint)})`,
      `      (property (name \"MPN\") (value ${JSON.stringify(component.partNumber)}))`,
      "    )",
    ].join("\n")),
    "  )",
    "  (nets",
    ...REFERENCE_KICAD_REQUIRED_NETS.map((netName, index) =>
      `    (net (code \"${index + 1}\") (name ${JSON.stringify(netName)})${
        index === 0 && options.addUnknownNetlistNodeReference === true
          ? ` (node (ref ${JSON.stringify(unexpectedReference)}) (pin "1"))`
          : ""
      })`,
    ),
    "  )",
    ")",
    "",
  ].join("\n");
  const csvField = (value: string): string =>
    /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const syntheticBom = [
    "Reference,Value,Footprint,MPN,Quantity,DNP",
    ...selectedComponents.map((component) =>
      [
        component.reference,
        component.value,
        component.footprint,
        component.partNumber,
        "1",
        component.reference === deliberatelyExcludedPositionReference &&
          options.positionExclusionReason === "dnp"
          ? "DNP"
          : "",
      ]
        .map(csvField)
        .join(","),
    ),
    "",
  ].join("\n");
  const syntheticPositionRows = selectedComponents
      .filter((component, index) =>
        !(
          component.reference === deliberatelyExcludedPositionReference &&
          (options.positionExclusionReason === "exclude_from_pos_files" ||
            positionCommandExcludeDnp)
        ) &&
        !(options.omitPositionReference === true && index === 0)
      )
      .map((component, index) =>
      [
        component.reference,
        component.value,
        component.footprint.split(":").at(-1)!,
        String(index),
        String(index),
        "0",
        "top",
      ].map(csvField).join(","),
    );
  const validSyntheticPositions = [
        "Ref,Val,Package,PosX,PosY,Rot,Side",
        ...syntheticPositionRows,
        ...(options.duplicatePositionReference === true
          ? [syntheticPositionRows[0]!]
          : []),
        ...(options.addUnexpectedPositionReference === true
          ? [`${unexpectedReference},unexpected,unexpected,0,0,0,top`]
          : []),
        "",
      ].join("\n");
  const syntheticPositions = options.unterminatedPositionCsv === true
    ? 'Ref,Val,Package,PosX,PosY,Rot,Side\n"unterminated'
    : options.invalidPositionQuote === "mid_field"
      ? validSyntheticPositions.replace(
          positionMutationReference,
          `${positionMutationReference.slice(0, -1)}"${positionMutationReference.at(-1)!}`,
        )
      : options.invalidPositionQuote === "trailing_data"
        ? validSyntheticPositions.replace("Ref,Val", '"Ref"trailing,Val')
        : validSyntheticPositions;

  const sourceContent = (logicalPath: (typeof SYNTHETIC_SOURCE_PATHS)[number]): string => {
    if (logicalPath === "sym-lib-table") {
      return SYNTHETIC_SOURCE_PATHS.filter((candidate) => candidate.endsWith(".kicad_sym"))
        .map((candidate) => `(lib (name "synthetic")(uri "\${KIPRJMOD}/${candidate}"))`)
        .join("\n");
    }
    if (logicalPath === "fp-lib-table") {
      if (options.omitFootprintDeclaration === true) return "(fp_lib_table)\n";
      return '(lib (name "robotics_edge")(uri "${KIPRJMOD}/footprints/robotics_edge.pretty"))\n';
    }
    if (logicalPath === "robotics-controller-v0.kicad_pcb") return syntheticBoard;
    return `synthetic ${logicalPath}\n`;
  };

  const sourceBindings = (await Promise.all(
    SYNTHETIC_SOURCE_PATHS.map(async (logicalPath) =>
      await writeBound(logicalPath, sourceContent(logicalPath)),
    ),
  )).sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  const sourceDigest = contentIdentity(canonicalJson(sourceBindings)).digest;
  const validationInputBindings = (await Promise.all(
    SYNTHETIC_SOURCE_PATHS.map(async (logicalPath) =>
      await writeBound(
        `${runRoot}/isolate/reference-input/${logicalPath}`,
        sourceContent(logicalPath),
      ),
    ),
  )).sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  const boardBinding = sourceBindings.find(
    (binding) => binding.path === "robotics-controller-v0.kicad_pcb",
  )!;
  const generatorSourceHashes = await Promise.all(
    REFERENCE_KICAD_GENERATOR_INPUT_PATHS.map(
      async (logicalPath) =>
        logicalPath === REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH
          ? {
              path: logicalPath,
              sizeBytes: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY.size,
              sha256: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY.digest,
            }
          : await writeBound(logicalPath, `# synthetic ${logicalPath}\n`),
    ),
  );
  const generatorSourceDigest = contentIdentity(canonicalJson(generatorSourceHashes)).digest;
  const preRefillBoardBinding = await writeBound(
    `${runRoot}/evidence/pre-refill/robotics-controller-v0.kicad_pcb`,
    syntheticBoard,
  );
  const evaluatedBoardBinding = await writeBound(
    `${runRoot}/evidence/drc-evaluated/robotics-controller-v0.kicad_pcb`,
    syntheticBoard,
  );

  const ercBinding = await writeJson(`${runRoot}/erc.json`, {
    $schema: "https://schemas.kicad.org/erc.v1.json",
    coordinate_units: "mm",
    date: "2026-09-03T00:00:00.000Z",
    kicad_version: REFERENCE_KICAD_VERSION,
    sheets: [{ path: "/", violations: [] }],
    source: "robotics-controller-v0.kicad_sch",
  });
  const drcBinding = await writeJson(`${runRoot}/drc.json`, {
    $schema: "https://schemas.kicad.org/drc.v1.json",
    coordinate_units: "mm",
    date: "2026-09-03T00:00:00.000Z",
    kicad_version: REFERENCE_KICAD_VERSION,
    schematic_parity: [],
    source: "robotics-controller-v0.kicad_pcb",
    unconnected_items: [],
    violations: [],
  });
  const generatorDocument = {
    schema_version: 2,
    generator: "KiCad pcbnew Python API",
    kicad_version: REFERENCE_KICAD_VERSION,
    boardPath: "robotics-controller-v0.kicad_pcb",
    boardSizeBytes: boardBinding.sizeBytes,
    boardSha256:
      options.generatorBoardDigestMismatch === true ? "0".repeat(64) : boardBinding.sha256,
    board_mm: [60, 45],
    copper_layers: 6,
    footprint_count: selectedComponents.length,
    track_count: 1,
    via_count: 0,
    track_and_via_count: options.generatorTrackCountMismatch === true ? 2 : 1,
    pre_zone_fill_native_unconnected_count: 0,
    width_api_check: { tracks: 1, vias: 0 },
    zone_fill: "pcbnew-zone-filler-after-bound-replay",
    sixLayerHdiFinalization: {
      schemaVersion: "evleda.six-layer-hdi-finalization.v1",
      removedRedundantMicrovia: { net: "M2_FAULT", positionMm: [62.1, 52.175] },
      microviaDiameterMm: 0.26,
      microviaDrillMm: 0.1,
      microviaLayerPair: ["F.Cu", "In1.Cu"],
      remainingMicroviaCount: 11,
      planeZonesRefilled: true,
      projectRules: {
        minimumMicroviaDiameterMm: 0.26,
        minimumMicroviaDrillMm: 0.1,
        minimumThroughHoleDiameterMm: 0.2,
        minimumViaAnnularWidthMm: 0.08,
      },
    },
    plane_connections: [{ status: "connected" }],
    placements: [{ status: "placed" }],
    plane_connection_failure_count: 0,
    partial_route_count: 0,
    unresolved_connection_count: 0,
    single_pad_net_count: 0,
    unresolved_placement_count: 0,
    zone_count: 0,
    routes: [
      {
        status: "routed",
        endpoint_count: 2,
        connected_component_count: 1,
        unconnected_endpoint_count: 0,
        unresolved_endpoint_count: 0,
        routed_pairs: 1,
        failures: [],
      },
    ],
  };
  const generatorBinding = await writeJson(
    `${runRoot}/evidence/pre-refill/pcb-generation.json`,
    generatorDocument,
  );
  const generatorSemanticPayload = structuredClone(generatorDocument) as Record<string, unknown>;
  delete generatorSemanticPayload.boardSha256;
  const generatorSemanticSha256 = contentIdentity(canonicalJson(generatorSemanticPayload)).digest;
  const requiredNets = [...REFERENCE_KICAD_REQUIRED_NETS].sort();
  if (options.omitRequiredNet === true) requiredNets.pop();
  const connectivityDocument: Record<string, unknown> = {
    boardNetlistRecordCount: 1,
    boardNetNames: requiredNets,
    missingRequiredBoardNets: [],
    semanticAliasBoardNetNames: [],
    boardFormatValid: true,
    missingRequiredNets: [],
    semanticAliasNetNames: [],
    netCount: requiredNets.length,
    netNames: requiredNets,
    requiredNetContract: "robotics-controller-v0.backend-v1",
    requiredNetContractIdentity: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
    requiredNetContractContentIdentity:
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
    requiredNetContractFile: {
      path: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
      sizeBytes: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY.size,
      sha256: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY.digest,
    },
    requiredNetCount: REFERENCE_KICAD_REQUIRED_NETS.length,
    schemaVersion: "evleda.reference-connectivity.v1",
    schematicComponentCount: 1,
    schematicReferences: [REFERENCE_CONTROLLER_REV_A_MCU_REFERENCE],
    schematicNetlistParseError: null,
    sourceDigest,
    status: "pass",
  };
  options.mutateConnectivity?.(connectivityDocument);
  const connectivityBinding = await writeJson(
    `${runRoot}/connectivity.json`,
    connectivityDocument,
  );
  const statisticsBinding = await writeJson(`${runRoot}/outputs/board-statistics.json`, {
    board: { has_outline: true },
    components: { total: { total: selectedComponents.length } },
    metadata: {
      board_name: "robotics-controller-v0",
      generator: `KiCad ${REFERENCE_KICAD_VERSION}`,
      project: "robotics-controller-v0",
    },
  });
  const bomBinding = await writeBound(`${runRoot}/outputs/bom.csv`, syntheticBom);
  const netlistBinding = await writeBound(
    `${runRoot}/outputs/schematic-netlist.kicad_net`,
    syntheticNetlist,
  );
  const exportBindings = [
    statisticsBinding,
    bomBinding,
    netlistBinding,
    await writeBound(`${runRoot}/outputs/board-netlist.d356`, "P  CODE 00\n317X\n999\n"),
    await writeBound(`${runRoot}/outputs/board-top.png`, "png-top"),
    await writeBound(`${runRoot}/outputs/board-bottom.png`, "png-bottom"),
    await writeBound(`${runRoot}/outputs/board-top.svg`, "<svg/>\n"),
    await writeBound(`${runRoot}/outputs/board-bottom.svg`, "<svg/>\n"),
    await writeBound(`${runRoot}/outputs/schematic.pdf`, "synthetic-pdf"),
    await writeBound(`${runRoot}/outputs/schematic-svg/root.svg`, "<svg/>\n"),
    await writeBound(`${runRoot}/outputs/positions.csv`, syntheticPositions),
    await writeBound(`${runRoot}/outputs/gerbers/F_Cu.gbr`, "G04 synthetic*\n"),
    await writeBound(`${runRoot}/outputs/drill/board.drl`, "M48\n"),
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const outputById: Readonly<Record<string, string>> = {
    "10-erc": `${runRoot}/erc.json`,
    "11-drc-parity": `${runRoot}/drc.json`,
    "20-bom": `${runRoot}/outputs/bom.csv`,
    "21-netlist": `${runRoot}/outputs/schematic-netlist.kicad_net`,
    "22-schematic-svg": `${runRoot}/outputs/schematic-svg`,
    "23-schematic-pdf": `${runRoot}/outputs/schematic.pdf`,
    "30-gerbers": `${runRoot}/outputs/gerbers`,
    "31-drill": `${runRoot}/outputs/drill`,
    "32-position": `${runRoot}/outputs/positions.csv`,
    "33-render-top": `${runRoot}/outputs/board-top.png`,
    "34-render-bottom": `${runRoot}/outputs/board-bottom.png`,
    "35-board-stats": `${runRoot}/outputs/board-statistics.json`,
    "36-board-ipcd356": `${runRoot}/outputs/board-netlist.d356`,
    "37-board-svg-top": `${runRoot}/outputs/board-top.svg`,
    "38-board-svg-bottom": `${runRoot}/outputs/board-bottom.svg`,
  };
  const invocations = [];
  const capabilityHash = createHash("sha256");
  const directoryOutputIds = new Set(["22-schematic-svg", "30-gerbers", "31-drill"]);
  for (const [id, prefix] of VALIDATION_COMMANDS) {
    const output = outputById[id];
    const args: string[] = [...prefix];
    if (id === "10-erc") {
      args.push("--format", "json", "--units", "mm", "--severity-all", "--exit-code-violations");
    } else if (id === "11-drc-parity") {
      args.push(
        "--schematic-parity",
        "--refill-zones",
        "--save-board",
        "--format",
        "json",
        "--units",
        "mm",
        "--severity-all",
        "--exit-code-violations",
      );
    } else if (id === "32-position") {
      args.push("--side", "both", "--format", "csv", "--units", "mm");
      if (positionCommandExcludeDnp) args.push("--exclude-dnp");
    }
    if (output !== undefined) {
      args.push("--output", path.join(referenceRoot, ...output.split("/")));
      args.push(
        path.join(referenceRoot, ...(
          id === "11-drc-parity"
            ? `${runRoot}/private/drc-work/robotics-controller-v0.kicad_pcb`
            : prefix[0] === "sch"
            ? `${runRoot}/isolate/reference-input/${
                "robotics-controller-v0.kicad_sch"
              }`
            : `${runRoot}/evidence/drc-evaluated/robotics-controller-v0.kicad_pcb`
        ).split("/")),
      );
    }
    const stdoutText =
      id === "00-version"
        ? `${REFERENCE_KICAD_VERSION}\n`
        : id === "01-commit"
          ? "146a4f2a7585c65bc580427a19b6fe2ec4a3f622\n"
          : id.startsWith("help-")
            ? `synthetic help for ${id}\n`
            : "";
    if (id.startsWith("help-")) {
      capabilityHash.update(`${args.join("\0")}\0${stdoutText}\n\0`);
    }
    const isCheck = id === "10-erc" || id === "11-drc-parity";
    const invocation: Record<string, unknown> = {
      id,
      args,
      cwd:
        output === undefined
          ? referenceRoot
          : path.join(
              referenceRoot,
              ...(id === "11-drc-parity"
                ? `${runRoot}/private/drc-work`
                : `${runRoot}/isolate/reference-input`
              ).split("/"),
            ),
      exitCode: 0,
      startedAt: "2026-09-03T00:00:00.000Z",
      finishedAt: "2026-09-03T00:00:00.001Z",
      durationMs: 1,
      expectedExitCodes: isCheck ? [0, 5] : [0],
      exitCodeAccepted: true,
      stdout: await writeBound(`${runRoot}/logs/${id}.stdout.txt`, stdoutText),
      stderr: await writeBound(`${runRoot}/logs/${id}.stderr.txt`, ""),
    };
    if (output !== undefined && !directoryOutputIds.has(id)) {
      invocation.freshTarget = {
        path: output,
        removedPreexisting: false,
        created: true,
        nonempty: true,
      };
    }
    if (isCheck) {
      Object.assign(invocation, {
        reportValid: true,
        reportError: null,
        reportFindingCount: 0,
        expectedExitCodeFromReport: 0,
        commandReportAgreement: true,
      });
    }
    invocations.push(invocation);
  }
  const capabilityHelpSha256 = capabilityHash.digest("hex");
  const commandsBinding = await writeJson(`${runRoot}/commands.json`, invocations);
  const componentMetadataBinding = await writeJson(`${runRoot}/component-metadata.json`, {
    schemaVersion: "evleda.reference-component-metadata.v1",
    status: "pass",
    sourceDigest,
    expectedComponentCount: selectedComponents.length,
    sourceComponentCounts: {
      schematic: selectedComponents.length,
      pcb: selectedComponents.length,
      bom: selectedComponents.length,
    },
    mismatches: [],
    errors: [],
    sourceBindings: {
      schematic: netlistBinding,
      pcb: evaluatedBoardBinding,
      bom: bomBinding,
    },
  });
  const boardSemanticSha256 = boardBinding.sha256;
  const replayScripts = Object.fromEntries(
    REFERENCE_KICAD_REPLAY_SCRIPT_PATHS.map((logicalPath) => [
      logicalPath,
      generatorSourceHashes.find((binding) => binding.path === logicalPath)!.sha256,
    ]),
  );
  const receiptBinding = (
    logicalPath: string,
    identity: { readonly sha256: string; readonly sizeBytes: number },
  ) => ({ path: logicalPath, sha256: identity.sha256, sizeBytes: identity.sizeBytes });
  const arbitraryReceiptBinding = (logicalPath: string, content: string) => {
    const identity = contentIdentity(content);
    return { path: logicalPath, sha256: identity.digest, sizeBytes: identity.size };
  };
  const receiptOutputs = [
    receiptBinding("drc.json", drcBinding),
    receiptBinding("erc.json", ercBinding),
    arbitraryReceiptBinding("preparation-report.json", "synthetic preparation report\n"),
    arbitraryReceiptBinding("prepared.kicad_pcb", "synthetic prepared board\n"),
    receiptBinding("robotics-controller-v0.kicad_pcb", boardBinding),
    receiptBinding(
      "robotics-controller-v0.kicad_pro",
      sourceBindings.find((binding) => binding.path === "robotics-controller-v0.kicad_pro")!,
    ),
    receiptBinding("route-report.json", generatorBinding),
    arbitraryReceiptBinding("route-stage-report.json", "synthetic route stage report\n"),
    arbitraryReceiptBinding("routed.kicad_pcb", "synthetic routed board\n"),
  ].sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  const receiptOutput = (logicalPath: string) =>
    receiptOutputs.find((entry) => entry.path === logicalPath)!;
  const receiptCommandSpecs = [
    ["prepare", "kicad_python", [
      "tooling/prepare_sixlayer_hdi.py", "--input-board", "routing-seed/open6.kicad_pcb",
      "--schematic", "robotics-controller-v0.kicad_sch", "--output-board", "prepared.kicad_pcb",
      "--report", "preparation-report.json",
    ]],
    ["route", "kicad_python", [
      "tooling/route_in1.py", "--board", "prepared.kicad_pcb", "--report",
      "routing-seed/open6-pcb-generation.json", "--nets",
      "BOARD_ID0,M2_FAULT,M1_FAULT,M2_DIR,M1_DIR,CAN_RX", "--output-board",
      "routed.kicad_pcb", "--output-report", "route-stage-report.json",
    ]],
    ["finalize", "kicad_python", [
      "tooling/finalize_sixlayer_hdi.py", "--board", "routed.kicad_pcb", "--route-report",
      "route-stage-report.json", "--output-board", "robotics-controller-v0.kicad_pcb",
      "--output-report", "route-report.json", "--project", "robotics-controller-v0.kicad_pro",
    ]],
    ["erc", "kicad_cli", [
      "sch", "erc", "--format", "json", "--units", "mm", "--severity-all",
      "--exit-code-violations", "--output", "erc.json",
      "native-check/robotics-controller-v0.kicad_sch",
    ]],
    ["drc", "kicad_cli", [
      "pcb", "drc", "--schematic-parity", "--refill-zones", "--save-board", "--format",
      "json", "--units", "mm", "--severity-all", "--exit-code-violations", "--output",
      "drc.json", "native-check/robotics-controller-v0.kicad_pcb",
    ]],
  ] as const;
  const receiptFor = async (index: number) => {
    const nonce = contentIdentity(`synthetic receipt nonce ${index}`).digest;
    const rootBinding = {
      pathDigest: contentIdentity(`synthetic canonical root ${index}`).digest,
      device: "1",
      inode: index.toString(),
      ancestryDigests: [contentIdentity("synthetic canonical parent").digest],
    };
    const writerBinding = generatorSourceHashes.find(
      (entry) => entry.path === "write_sixlayer_regeneration_evidence.py",
    )!;
    const issuancePayload = {
      schemaVersion: "evleda.sixlayer-regeneration-issuance.v1",
      issuanceId: `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      challenge: nonce,
      issuedAt: "2026-09-02T23:59:59.999Z",
      rootBinding,
      writerIdentity: {
        algorithm: "sha256" as const,
        digest: writerBinding.sha256,
        size: writerBinding.sizeBytes,
      },
    };
    const issuance = {
      ...issuancePayload,
      identity: canonicalIdentity(issuancePayload, "evleda.sixlayer-regeneration-issuance.v1"),
    };
    const runInputMap = new Map<string, { path: string; sha256: string; sizeBytes: number }>();
    for (const binding of sourceBindings) runInputMap.set(binding.path, { ...binding });
    for (const logicalPath of REFERENCE_KICAD_REPLAY_SCRIPT_PATHS) {
      const binding = generatorSourceHashes.find((entry) => entry.path === logicalPath)!;
      runInputMap.set(`tooling/${logicalPath}`, { ...binding, path: `tooling/${logicalPath}` });
    }
    for (const logicalPath of ["routing-seed/open6-pcb-generation.json", "routing-seed/open6.kicad_pcb"] as const) {
      const binding = generatorSourceHashes.find((entry) => entry.path === logicalPath)!;
      runInputMap.set(logicalPath, { ...binding });
    }
    for (const binding of sourceBindings.filter((entry) => entry.path.startsWith("footprints/"))) {
      runInputMap.set(`tooling/${binding.path}`, { ...binding, path: `tooling/${binding.path}` });
    }
    const issuanceBytes = canonicalJson(issuance);
    const issuanceContentIdentity = contentIdentity(issuanceBytes);
    runInputMap.set("writer-issuance.json", {
      path: "writer-issuance.json",
      sha256: issuanceContentIdentity.digest,
      sizeBytes: issuanceContentIdentity.size,
    });
    const runnerBinding = generatorSourceHashes.find(
      (entry) => entry.path === "run_sixlayer_regeneration.py",
    )!;
    const payload = {
      schemaVersion: "evleda.sixlayer-regeneration-run-receipt.v2",
      runId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      nonce,
      rootBinding,
      lifecycle: "candidate",
      releaseAuthorized: false,
      startedAt: "2026-09-03T00:00:00.000Z",
      completedAt: "2026-09-03T00:00:00.005Z",
      sourceSnapshot: { digest: sourceDigest, bindings: sourceBindings },
      generatorSnapshot: { digest: generatorSourceDigest, bindings: generatorSourceHashes },
      runInputs: [...runInputMap.values()].sort((left, right) =>
        left.path.localeCompare(right.path, "en-US")
      ),
      issuanceIdentity: issuance.identity,
      tools: {
        kicadPython: {
          kind: "kicad-python",
          version: "3.11.5-test",
          pcbnewVersion: REFERENCE_KICAD_VERSION,
          files: [
            { role: "launcher", identity: { algorithm: "sha256" as const, digest: "f9e290b5d6d3bd0371ec842ac83f451d72d2b3e173ad745e221f7d839a66e953", size: 103_776 } },
            { role: "pcbnew_module", identity: { algorithm: "sha256" as const, digest: "6b3f567f926bc219709c164c9286acce9c35d72e61e0172d59582fa8493471d1", size: 1_022_246 } },
            { role: "pcbnew_native", identity: { algorithm: "sha256" as const, digest: "3ea2d4d26d928addfe1439698d355655a89fa1a17054cfba54805470052f6b83", size: 31_095_136 } },
          ],
        },
        kicadCli: {
          kind: "kicad-cli",
          version: REFERENCE_KICAD_VERSION,
          commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
          contentIdentity: {
            algorithm: "sha256" as const,
            digest: "4e1910666330fa8f2321d4e616957dacab218a0d835c343c869a87757481c2f4",
            size: 2_696_544,
          },
          capabilityHelpSha256,
        },
        runner: {
          kind: "host-receipt-runner",
          logicalName: "run_sixlayer_regeneration.py",
          contentIdentity: {
            algorithm: "sha256" as const,
            digest: runnerBinding.sha256,
            size: runnerBinding.sizeBytes,
          },
        },
      },
      commands: receiptCommandSpecs.map(([operation, tool, commandArguments], zeroIndex) => {
        const sequence = zeroIndex + 1;
        const empty = contentIdentity("");
        return {
          sequence,
          operation,
          commandId: contentIdentity(`${nonce}\0${sequence.toString()}\0${operation}`).digest,
          tool,
          arguments: [...commandArguments],
          startedAt: `2026-09-03T00:00:00.00${zeroIndex}Z`,
          completedAt: `2026-09-03T00:00:00.00${zeroIndex + 1}Z`,
          durationMs: 1,
          exitCode: 0,
          stdout: {
            path: `receipt-logs/${sequence.toString().padStart(2, "0")}-${operation}.stdout.txt`,
            sha256: empty.digest,
            sizeBytes: empty.size,
          },
          stderr: {
            path: `receipt-logs/${sequence.toString().padStart(2, "0")}-${operation}.stderr.txt`,
            sha256: empty.digest,
            sizeBytes: empty.size,
          },
        };
      }),
      outputs: receiptOutputs,
      native: {
        erc: { report: receiptOutput("erc.json"), violationCount: 0 },
        drc: {
          report: receiptOutput("drc.json"),
          violationCount: 0,
          unconnectedCount: 0,
          schematicParityCount: 0,
        },
      },
      planner: {
        partialRouteCount: 0,
        unresolvedConnectionCount: 0,
        nativeUnconnectedCount: 0,
      },
    };
    const receipt = {
      ...payload,
      identity: canonicalIdentity(payload, "evleda.sixlayer-regeneration-run-receipt.v2"),
    };
    const retainedRoot = `${runRoot}/evidence/retained-receipt-${index.toString()}`;
    const receiptBytes = canonicalJson(receipt);
    const receiptRawIdentity = contentIdentity(receiptBytes);
    const inventoryFileMap = new Map(
      [
        ...receipt.runInputs,
        ...receipt.outputs,
        ...receipt.commands.flatMap((command) => [command.stdout, command.stderr]),
      ].map((entry) => [entry.path, entry] as const),
    );
    inventoryFileMap.set("regeneration-run-receipt.json", {
      path: "regeneration-run-receipt.json",
      sha256: receiptRawIdentity.digest,
      sizeBytes: receiptRawIdentity.size,
    });
    const inventoryFiles = [...inventoryFileMap.values()].sort((left, right) =>
      left.path.localeCompare(right.path, "en-US")
    );
    const inventoryPayload = {
      schemaVersion: "evleda.sixlayer-regeneration-root-inventory.v1",
      runId: receipt.runId,
      rootBinding,
      issuanceIdentity: issuance.identity,
      receiptIdentity: receipt.identity,
      files: inventoryFiles,
    };
    const inventory = {
      ...inventoryPayload,
      identity: canonicalIdentity(
        inventoryPayload,
        "evleda.sixlayer-regeneration-root-inventory.v1",
      ),
    };
    const issuanceFile = await writeBound(`${retainedRoot}/issuance.json`, issuanceBytes);
    const receiptFile = await writeBound(`${retainedRoot}/receipt.json`, receiptBytes);
    const inventoryFile = await writeBound(`${retainedRoot}/inventory.json`, canonicalJson(inventory));
    const transcripts = await Promise.all(receipt.commands.map(async (command) => ({
      operation: command.operation,
      stdout: await writeBound(`${retainedRoot}/transcripts/${command.operation}.stdout.txt`, ""),
      stderr: await writeBound(`${retainedRoot}/transcripts/${command.operation}.stderr.txt`, ""),
    })));
    const outputContents: Readonly<Record<string, string>> = {
      "drc.json": await readFile(path.join(referenceRoot, ...drcBinding.path.split("/")), "utf8"),
      "erc.json": await readFile(path.join(referenceRoot, ...ercBinding.path.split("/")), "utf8"),
      "preparation-report.json": "synthetic preparation report\n",
      "prepared.kicad_pcb": "synthetic prepared board\n",
      "robotics-controller-v0.kicad_pcb": syntheticBoard,
      "robotics-controller-v0.kicad_pro": sourceContent("robotics-controller-v0.kicad_pro"),
      "route-report.json": canonicalJson(generatorDocument),
      "route-stage-report.json": "synthetic route stage report\n",
      "routed.kicad_pcb": "synthetic routed board\n",
    };
    const retainedOutputs = await Promise.all(receipt.outputs.map(async (output) => ({
      logicalPath: output.path,
      file: await writeBound(
        `${retainedRoot}/outputs/${output.path}`,
        outputContents[output.path]!,
      ),
    })));
    return {
      receipt,
      retained: {
        runId: receipt.runId,
        receiptIdentity: receipt.identity,
        issuance: { document: issuance, file: issuanceFile },
        receiptFile,
        inventory: { document: inventory, file: inventoryFile },
        transcripts,
        outputs: retainedOutputs,
      },
    };
  };
  const receiptBundles = await Promise.all([receiptFor(1), receiptFor(2)]);
  const receiptRuns = receiptBundles.map((entry) => entry.receipt);
  const retainedRuns = receiptBundles.map((entry) => entry.retained);
  const regenerationDocument: Record<string, unknown> = {
    schemaVersion: "evleda.reference-regeneration.v3",
    receiptSchema: "evleda.sixlayer-regeneration-run-receipt.v2",
    status: "pass",
    sourceDigest,
    generatorSourceDigest,
    generatorSourceHashes,
    normalization: "none; fixed stage-specific KiCad KIID seeds produced byte-identical files",
    runCount: 2,
    runs: receiptRuns,
    retainedRuns,
    independence: {
      distinctCanonicalRoots: true,
      disjointRoots: true,
      distinctRunIds: true,
      distinctNonces: true,
      distinctRootBindings: true,
      distinctReceiptIdentities: true,
      independentlyExecutedCommands: true,
      writerChallengesMatched: true,
    },
    currentBoardSemanticSha256: boardSemanticSha256,
    currentGeneratorReportSemanticSha256: generatorSemanticSha256,
    semanticMatch: true,
    rawIdentityChecks: {
      board: true,
      generatorReport: true,
      preparationReport: true,
      project: true,
      replayScripts: true,
      routingSeed: true,
      receipts: true,
    },
    currentReplayScripts: replayScripts,
    toolchain: {
      version: REFERENCE_KICAD_VERSION,
      commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
      cliSha256: "4e1910666330fa8f2321d4e616957dacab218a0d835c343c869a87757481c2f4",
      capabilityHelpSha256,
    },
  };
  options.mutateRegenerationEvidence?.(regenerationDocument);
  const regenerationBinding = await writeJson(
    `${runRoot}/evidence/regeneration-evidence.json`,
    regenerationDocument,
  );
  const manifest: Record<string, unknown> = {
    schemaVersion: REFERENCE_VALIDATION_SCHEMA,
    design: "robotics-controller-v0",
    lifecycle: "candidate",
    releaseAuthorized: false,
    checksPass: true,
    createdAt: "2026-09-03T00:00:00.000Z",
    run: {
      id: runId,
      root: runRoot,
      privateEnvironment: {
        kicadConfig: `${runRoot}/private/kicad-config`,
        appData: `${runRoot}/private/appdata`,
        localAppData: `${runRoot}/private/localappdata`,
        temp: `${runRoot}/private/temp`,
      },
    },
    sourceDigest,
    sourceBindings,
    validationInputBindings,
    validationInputPreservation: {
      unchanged: true,
      before: validationInputBindings,
      after: validationInputBindings,
    },
    generatorSourceDigest,
    generatorSourceHashes,
    generatorSourcePreservation: {
      unchanged: true,
      before: generatorSourceHashes,
      after: generatorSourceHashes,
    },
    executable: {
      kind: "kicad-cli",
      executablePath: TEST_KICAD_CLI_PATH,
      sizeBytes: 2_696_544,
      sha256: "4e1910666330fa8f2321d4e616957dacab218a0d835c343c869a87757481c2f4",
      version: REFERENCE_KICAD_VERSION,
      commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
      capabilityHelpSha256,
      capabilityProbeArgs: VALIDATION_COMMANDS.filter(([id]) => id.startsWith("help-")).map(
        ([, args]) => [...args],
      ),
      identityMatchesAdapter: true,
    },
    invocations,
    erc: {
      ...ercBinding,
      sourceDigest,
      violationCount: 0,
      reportFindingCount: 0,
      reportValid: true,
      reportError: null,
      commandReportAgreement: true,
    },
    drc: {
      ...drcBinding,
      sourceDigest,
      violationCount: 0,
      schematicParityCount: 0,
      unconnectedCount: 0,
      reportFindingCount: 0,
      reportValid: true,
      reportError: null,
      commandReportAgreement: true,
      preRefillBoard: preRefillBoardBinding,
      evaluatedBoard: evaluatedBoardBinding,
      evaluatedBoardDigest: evaluatedBoardBinding.sha256,
      evaluatedBoardUnchangedAfterExports: true,
    },
    routing: {
      generatorReport: {
        ...generatorBinding,
        trustedForRoutingCounts: true,
        error: null,
        canonicalSourceUnchanged: true,
        preRefillBoard: preRefillBoardBinding,
        currentSemanticSha256: generatorSemanticSha256,
      },
      partialRouteCount: 0,
      generatorUnresolvedConnectionCount: 0,
      planeConnectionFailureCount: 0,
      singlePadIntentionalNetCount: 0,
      unroutedCount: 0,
    },
    placement: {
      boardSizeMm: [60, 45],
      footprintCount: selectedComponents.length,
      overlapCount: 0,
    },
    connectivity: {
      ...connectivityBinding,
      sourceDigest,
      missingRequiredNetCount: 0,
      missingRequiredBoardNetCount: 0,
      boardNetlistRecordCount: 1,
      componentMetadata: {
        ...componentMetadataBinding,
        sourceDigest,
        status: "pass",
        mismatchCount: 0,
        errorCount: 0,
      },
    },
    geometry: {
      ...statisticsBinding,
      sourceDigest,
      boardSizeMm: [60, 45],
      copperLayerCount: 6,
      zoneCount: 0,
    },
    exports: { commandsExitZero: true, requiredOutputsExist: true, artifacts: exportBindings },
    commands: commandsBinding,
    sourcePreservation: { unchanged: true, before: sourceBindings, after: sourceBindings },
    regeneration: {
      mode: "two-run-semantic-comparison",
      deterministicEvidencePending: false,
      requiredForCandidatePass: true,
      error: null,
      note: "Two isolated clean runs match semantically.",
      evidence: regenerationBinding,
    },
    unresolvedAssumptions: [
      {
        id: "PHYSICAL_QUALIFICATION_REQUIRED",
        severity: "blocking",
        scope: "qualification",
        statement:
          "No fabricated board, bench measurements, thermal characterization, EMC test, or safety qualification exists.",
      },
      {
        id: "MOTOR_RMS_LIMIT_FIRMWARE",
        severity: "blocking",
        scope: "qualification",
        statement:
          "0.5 A RMS per motor channel is a firmware and thermal qualification limit; hardware implements only a nominal 1 A chop target.",
      },
      {
        id: "HDI_FABRICATION_APPROVAL_REQUIRED",
        severity: "blocking",
        scope: "qualification",
        statement:
          "Published advanced-HDI process limits do not approve this exact 1+4+1 stackup; laminate, impedance, 0.26/0.10 mm laser microvias, build notes, and CAM require written fabrication-engineering approval.",
      },
    ],
  };
  options.mutateManifest?.(manifest);
  const semantic = structuredClone(manifest);
  delete semantic.createdAt;
  manifest.validationRoot = canonicalIdentity(semantic, REFERENCE_VALIDATION_SCHEMA);
  await writeFile(
    path.join(referenceRoot, "validation", "reference-validation.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { referenceRoot, workRoot, unexpectedReference, positionMutationReference };
}

describe("native firmware parity extraction", () => {
  it("derives complete pins from captured netlist nodes and binds the exact bytes", () => {
    const bytes = firmwareParityNetlist();
    const payload = deriveReferenceFirmwareParityFromNetlist(
      bytes,
      ROBOTICS_CONTROLLER_V0,
      SOURCE_DIGEST,
    );
    expect(payload.nativeNodes).toHaveLength(ROBOTICS_CONTROLLER_V0.pins.length);
    expect(payload.pins).toEqual(ROBOTICS_CONTROLLER_V0.pins);
    expect(payload.derivation.nativeNetlistIdentity).toEqual(contentIdentity(bytes));
    expect(payload.derivation.mappingModelIdentity.schemaVersion).toBe(
      "evleda.firmware-parity-mapping-model.v1",
    );
  });

  it("accepts the native Rev-A pin map for a supported narrower operating envelope", () => {
    const bytes = firmwareParityNetlist();
    const payload = deriveReferenceFirmwareParityFromNetlist(
      bytes,
      NARROW_PROFILE,
      SOURCE_DIGEST,
    );

    expect(payload).toMatchObject({
      profileId: NARROW_PROFILE.profileId,
      boardRevision: NARROW_PROFILE.boardRevision,
      profileIdentity: canonicalIdentity(
        NARROW_PROFILE,
        REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
      ),
      electricalEnvelope: {
        inputVoltageMv: { minimum: 9_000, maximum: 12_000 },
        motor: {
          channels: 2,
          rmsCurrentMaPerChannel: 250,
          currentChopMaPerChannel: 1_000,
        },
      },
      templateInstantiationMode: REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
    });
    expect(payload.nativeNodes).toHaveLength(NARROW_PROFILE.pins.length);
    expect(payload.pins).toEqual(NARROW_PROFILE.pins);
  });

  it("binds the exact narrowed request identity and records template reuse semantics", () => {
    const binding = referenceKicadRequestBinding(
      requestFor("schematic", NARROW_PROFILE, NARROW_PROMPT),
    );
    const identityPreimage = structuredClone(binding) as unknown as Record<string, unknown>;
    delete identityPreimage.identity;

    expect(binding).toMatchObject({
      schemaVersion: REFERENCE_KICAD_REQUEST_BINDING_SCHEMA,
      request: {
        schemaVersion: "evleda.kicad-request.v2",
        stage: "schematic",
        expectedSourceRevisionDigest: SOURCE_DIGEST,
      },
      templateInstantiation: {
        mode: REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
        requestedProfile: {
          profileIdentity: canonicalIdentity(
            NARROW_PROFILE,
            REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
          ),
          electricalEnvelope: {
            inputVoltageMv: { minimum: 9_000, maximum: 12_000 },
            motor: {
              channels: 2,
              rmsCurrentMaPerChannel: 250,
              currentChopMaPerChannel: 1_000,
            },
          },
        },
        reuse: {
          structuralRelationship: "identical",
          electricalEnvelopeRelationship: "requested-subset-of-template",
          topologyGenerationPerformed: false,
          nativeDesignMutationPerformed: false,
          artifactSemantics: "validated-template-copy-not-newly-generated-pcb",
        },
      },
    });
    expect(binding.identity).toEqual(
      canonicalIdentity(identityPreimage, REFERENCE_KICAD_REQUEST_BINDING_SCHEMA),
    );
  });

  it("recomputes PCB plan and analyzer-profile identities at the reference boundary", () => {
    const request = structuredClone(requestFor("pcb_placement_routing"));
    const engineering = request.pcbEngineering!;
    const tamperedPlan = {
      ...engineering.layoutPlan.document,
      planId: "tampered-after-identity",
    };

    expect(() => referenceKicadRequestBinding({
      ...request,
      pcbEngineering: {
        ...engineering,
        layoutPlan: { ...engineering.layoutPlan, document: tamperedPlan },
      },
    })).toThrow(ReferenceKicadBackendError);

    expect(() => referenceKicadRequestBinding({
      ...request,
      pcbEngineering: {
        ...engineering,
        analyzerProfile: {
          ...engineering.analyzerProfile,
          canonicalIdentity: canonicalIdentity(
            { forged: true },
            engineering.analyzerProfile.document.schemaVersion,
          ),
        },
      },
    })).toThrow(ReferenceKicadBackendError);
  });

  it("rejects a profile echo when an actual MCU node is wired to the wrong net", () => {
    expect(() =>
      deriveReferenceFirmwareParityFromNetlist(
        firmwareParityNetlist("MOTOR_A_PWM"),
        ROBOTICS_CONTROLLER_V0,
        SOURCE_DIGEST,
      ),
    ).toThrow(ReferenceKicadBackendError);
  });

  it("accepts the fresh native netlist with internal HSI and exact STM32 alias names", async () => {
    const manifest = JSON.parse(await readFile(VALIDATION_MANIFEST, "utf8")) as {
      run: { root: string };
    };
    const captured = await readFile(
      path.join(
        REFERENCE_ROOT,
        ...manifest.run.root.split("/"),
        "outputs",
        "schematic-netlist.kicad_net",
      ),
    );
    const result = deriveReferenceFirmwareParityFromNetlist(
      captured,
      ROBOTICS_CONTROLLER_V0,
      SOURCE_DIGEST,
    );

    expect(result.nativeNodes).toHaveLength(37);
    expect(result.nativeNodes.some((node) => node.mcuPin === "PF0" || node.mcuPin === "PF1")).toBe(false);
    expect(
      Object.fromEntries(
        result.nativeNodes
          .filter((node) => [29, 32, 33, 34].includes(node.physicalPin))
          .map((node) => [node.physicalPin, node.pinFunction]),
      ),
    ).toEqual({
      29: "PA9/UCPD1_DBCC1_29",
      32: "PA10/UCPD1_DBCC2_32",
      33: "PA9/PA11_33",
      34: "PA10/PA12_34",
    });
  });
});

describe("reviewed-template robotics-controller-v0 KiCad backend", () => {
  it.each([
    "REFERENCE_NATIVE_CONTRACT_SOURCE_UNAVAILABLE",
    "REFERENCE_NATIVE_CONTRACT_SOURCE_NOT_ORDINARY",
    "REFERENCE_NATIVE_CONTRACT_TOO_LARGE",
  ] as const)("maps reverify %s to a source-mutation integrity failure", async (code) => {
    const fixture = await syntheticPassingReference();
    const originalReverify =
      nativeContractAuthority.reverifyReferenceControllerRevANativeAuthority;
    let reverifyCount = 0;
    const reverifySpy = vi.spyOn(
      nativeContractAuthority,
      "reverifyReferenceControllerRevANativeAuthority",
    ).mockImplementation(async (snapshot) => {
      reverifyCount += 1;
      if (reverifyCount === 2) {
        throw new ReferenceControllerNativeContractError(code, "simulated authority drift");
      }
      await originalReverify(snapshot);
    });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });

    try {
      await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
        code: "ARTIFACT_INTEGRITY_ERROR",
        failureCode: "REFERENCE_SOURCE_MUTATED",
        details: { nativeContractErrorCode: code },
      });
      expect(reverifyCount).toBe(2);
    } finally {
      reverifySpy.mockRestore();
    }
  });

  it("uses the single validated manifest snapshot after tool discovery", async () => {
    const fixture = await syntheticPassingReference();
    const fakeExecutableDirectory = path.join(path.dirname(fixture.referenceRoot), "fake-tools");
    const fakeExecutable = path.join(fakeExecutableDirectory, "kicad-cli.exe");
    await mkdir(fakeExecutableDirectory);
    await writeFile(fakeExecutable, "adapter-create-is-mocked\n", "utf8");
    const validationPath = path.join(
      fixture.referenceRoot,
      "validation",
      "reference-validation.json",
    );
    const trustedExecutable = (JSON.parse(await readFile(validationPath, "utf8")) as {
      readonly executable: {
        readonly sizeBytes: number;
        readonly sha256: string;
        readonly version: string;
        readonly commit: string;
        readonly capabilityHelpSha256: string;
      };
    }).executable;
    let runChecksCalled = false;
    const createSpy = vi.spyOn(KicadCliAdapter, "create").mockImplementation(async () => {
      await writeFile(validationPath, "not-json-after-validation\n", "utf8");
      return {
      identity: {
        kind: "kicad-cli",
        path: fakeExecutable,
        sizeBytes: trustedExecutable.sizeBytes,
        sha256: trustedExecutable.sha256,
        version: trustedExecutable.version,
        commit: trustedExecutable.commit,
        capabilityHelpSha256: trustedExecutable.capabilityHelpSha256,
        confirmedCapabilities: [],
      },
      async runChecks() {
        runChecksCalled = true;
        throw new Error("stop after validated-manifest snapshot assertion");
      },
      } as unknown as KicadCliAdapter;
    });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: fakeExecutable,
    });

    try {
      await expect(backend.execute(requestFor("schematic"))).rejects.toBeInstanceOf(
        ReferenceKicadBackendError,
      );
      expect(runChecksCalled).toBe(true);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("accepts a canonical narrower profile through the synthetic reference gate", async () => {
    const fixture = await syntheticPassingReference();
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: process.execPath,
    });

    await expect(
      backend.execute(requestFor("schematic", NARROW_PROFILE, NARROW_PROMPT)),
    ).rejects.toMatchObject({
      code: "TOOLCHAIN_UNSUPPORTED",
      failureCode: "REFERENCE_TOOLCHAIN_MISMATCH",
    });
    expect(await readdir(fixture.workRoot)).toEqual([]);
  });

  it("rejects a hand-edited operating point that is not a canonical factory instantiation", async () => {
    const workRoot = await temporaryDirectory("evleda-reference-backend-unsupported-");
    const changed: ReferenceControllerProfile = {
      ...structuredClone(ROBOTICS_CONTROLLER_V0),
      motor: { ...ROBOTICS_CONTROLLER_V0.motor, rmsCurrentMaPerChannel: 400 },
    };
    const backend = new ReferenceKicadBackend({ workRoot, referenceDesignRoot: REFERENCE_ROOT });

    await expect(backend.execute(requestFor("schematic", changed))).rejects.toMatchObject({
      name: "ReferenceKicadBackendError",
      code: "TOOLCHAIN_UNSUPPORTED",
      failureCode: "REFERENCE_PROFILE_UNSUPPORTED",
      details: {
        unsupportedReasons: ["PROFILE_NOT_CANONICAL_REVIEWED_TEMPLATE_INSTANTIATION"],
      },
    });
  });

  it.each([
    {
      name: "profile family",
      profile: { ...structuredClone(NARROW_PROFILE), profileId: "robotics-controller-v1" },
    },
    {
      name: "component MPN set",
      profile: {
        ...structuredClone(NARROW_PROFILE),
        components: NARROW_PROFILE.components.map((component) =>
          component.key === "mcu"
            ? { ...component, partNumber: "UNREVIEWED-MCU" }
            : structuredClone(component),
        ),
      },
    },
    {
      name: "pin assignment set",
      profile: {
        ...structuredClone(NARROW_PROFILE),
        pins: NARROW_PROFILE.pins.map((pin, index) =>
          index === 0 ? { ...pin, physicalPin: pin.physicalPin + 1 } : structuredClone(pin),
        ),
      },
    },
    {
      name: "resource allocation set",
      profile: {
        ...structuredClone(NARROW_PROFILE),
        resources: NARROW_PROFILE.resources.map((resource, index) =>
          index === 0
            ? { ...resource, resource: `${resource.resource} altered` }
            : structuredClone(resource),
        ),
      },
    },
    {
      name: "protocol contract set",
      profile: {
        ...structuredClone(NARROW_PROFILE),
        protocols: NARROW_PROFILE.protocols.map((protocol, index) =>
          index === 0
            ? { ...protocol, controller: `${protocol.controller} altered` }
            : structuredClone(protocol),
        ),
      },
    },
    {
      name: "layout constraint set",
      profile: {
        ...structuredClone(NARROW_PROFILE),
        layoutConstraints: NARROW_PROFILE.layoutConstraints.map((constraint, index) =>
          index === 0
            ? { ...constraint, rule: `${constraint.rule} altered` }
            : structuredClone(constraint),
        ),
      },
    },
    {
      name: "rail contract set",
      profile: {
        ...structuredClone(NARROW_PROFILE),
        rails: NARROW_PROFILE.rails.map((rail, index) =>
          index === 0 ? { ...rail, budgetMa: rail.budgetMa + 1 } : structuredClone(rail),
        ),
      },
    },
  ])("rejects a supported-envelope profile with a changed $name", async ({ profile }) => {
    const workRoot = await temporaryDirectory("evleda-reference-backend-structural-");
    const backend = new ReferenceKicadBackend({ workRoot, referenceDesignRoot: REFERENCE_ROOT });

    await expect(
      backend.execute(
        requestFor("schematic", profile as ReferenceControllerProfile, NARROW_PROMPT),
      ),
    ).rejects.toMatchObject({
      name: "ReferenceKicadBackendError",
      code: "TOOLCHAIN_UNSUPPORTED",
      failureCode: "REFERENCE_PROFILE_UNSUPPORTED",
      details: {
        unsupportedReasons: ["PROFILE_NOT_CANONICAL_REVIEWED_TEMPLATE_INSTANTIATION"],
      },
    });
  });

  it.each([
    {
      name: "input below 7 V",
      profile: createReferenceControllerProfile({
        inputVoltageMv: { minimum: 6_000, maximum: 12_000 },
      }),
      reason: "INPUT_VOLTAGE_OUTSIDE_7000_16800_MV",
    },
    {
      name: "input above 16.8 V",
      profile: createReferenceControllerProfile({
        inputVoltageMv: { minimum: 9_000, maximum: 17_000 },
      }),
      reason: "INPUT_VOLTAGE_OUTSIDE_7000_16800_MV",
    },
    {
      name: "current above 500 mA RMS",
      profile: createReferenceControllerProfile({
        motor: {
          channels: 2,
          rmsCurrentMaPerChannel: 501,
          currentChopMaPerChannel: 1_000,
        },
      }),
      reason: "MOTOR_RMS_CURRENT_OUTSIDE_V0_LIMIT",
    },
    {
      name: "different channel count",
      profile: createReferenceControllerProfile({
        motor: {
          channels: 3,
          rmsCurrentMaPerChannel: 250,
          currentChopMaPerChannel: 1_000,
        },
      }),
      reason: "MOTOR_CHANNEL_COUNT_REQUIRES_NEW_CIRCUIT",
    },
    {
      name: "different chop circuit",
      profile: createReferenceControllerProfile({
        motor: {
          channels: 2,
          rmsCurrentMaPerChannel: 250,
          currentChopMaPerChannel: 900,
        },
      }),
      reason: "CURRENT_CHOP_CHANGE_REQUIRES_NEW_SOURCE_BOUND_CALCULATION",
    },
    {
      name: "different board revision",
      profile: createReferenceControllerProfile({ boardRevision: "EVL-RC-G0-REV-B" }),
      reason: "BOARD_REVISION_STRAPS_REQUIRE_NEW_REVIEW",
    },
    {
      name: "different stackup",
      profile: createReferenceControllerProfile({
        stackup: { layerCount: 2, layers: ["F.Cu", "B.Cu"] },
      }),
      reason: "STACKUP_CHANGE_REQUIRES_NEW_LAYOUT_VALIDATION",
    },
    {
      name: "incomplete interface set",
      profile: createReferenceControllerProfile({
        interfaceSelections: ["USB", "CAN", "UART", "I2C", "SWD", "ENCODER"],
      }),
      reason: "INTERFACE_SET_CHANGE_REQUIRES_NEW_PIN_AND_CIRCUIT_PROFILE",
    },
  ])("fails closed for $name", async ({ profile, reason }) => {
    const workRoot = await temporaryDirectory("evleda-reference-backend-envelope-");
    const backend = new ReferenceKicadBackend({ workRoot, referenceDesignRoot: REFERENCE_ROOT });

    await expect(backend.execute(requestFor("schematic", profile))).rejects.toMatchObject({
      name: "ReferenceKicadBackendError",
      code: "TOOLCHAIN_UNSUPPORTED",
      failureCode: "REFERENCE_PROFILE_UNSUPPORTED",
      details: { unsupportedReasons: expect.arrayContaining([reason]) },
    });
  });

  it("returns a typed missing-evidence failure when canonical validation is absent", async () => {
    const fixtureRoot = await temporaryDirectory("evleda-reference-backend-no-validation-");
    const referenceRoot = path.join(fixtureRoot, "reference");
    const workRoot = path.join(fixtureRoot, "work");
    await Promise.all([mkdir(referenceRoot), mkdir(workRoot)]);
    await mkdir(path.join(referenceRoot, "symbols"));
    await Promise.all(
      [
        "robotics-controller-v0.kicad_pro",
        "robotics-controller-v0.kicad_sch",
        "robotics-controller-v0.kicad_pcb",
        "robotics-controller-v0.kicad_dru",
        "sym-lib-table",
        "fp-lib-table",
        "symbols/robotics_drv8874.kicad_sym",
        "symbols/robotics_lmr51420.kicad_sym",
        "symbols/robotics_sn74lvc2g17.kicad_sym",
        "symbols/robotics_tcan3413.kicad_sym",
        "symbols/robotics_tps2553.kicad_sym",
        "symbols/robotics_usb_c.kicad_sym",
        "symbols/robotics_usblc6.kicad_sym",
      ].map(async (name) => await writeFile(path.join(referenceRoot, name), `${name}\n`, "utf8")),
    );
    const backend = new ReferenceKicadBackend({ workRoot, referenceDesignRoot: referenceRoot });

    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      name: "ReferenceKicadBackendError",
      code: "EVIDENCE_MISSING",
      failureCode: "REFERENCE_VALIDATION_MISSING",
    });
  });

  it("accepts qualification-only blockers, completed semantic determinism, and manifest-bound local footprints", async () => {
    const fixture = await syntheticPassingReference();
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: process.execPath,
    });

    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      code: "TOOLCHAIN_UNSUPPORTED",
      failureCode: "REFERENCE_TOOLCHAIN_MISMATCH",
    });
    expect(await readdir(fixture.workRoot)).toEqual([]);
  });

  it("rejects rehashed regeneration evidence detached from the current replay scripts", async () => {
    const fixture = await syntheticPassingReference({
      mutateRegenerationEvidence(evidence) {
        const scripts = evidence.currentReplayScripts as Record<string, unknown>;
        scripts["generate_pcb.py"] = "f".repeat(64);
      },
    });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });

    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
      failureCode: "REFERENCE_VALIDATION_STALE",
    });
  });

  it.each([
    {
      name: "the same receipt used for both runs",
      mutate(evidence: Record<string, unknown>) {
        const runs = evidence.runs as Record<string, unknown>[];
        runs[1] = structuredClone(runs[0]!);
      },
    },
    {
      name: "a copied root receipt with a different label",
      mutate(evidence: Record<string, unknown>) {
        const runs = evidence.runs as Record<string, unknown>[];
        runs[1]!.rootBinding = structuredClone(runs[0]!.rootBinding);
        const payload = structuredClone(runs[1]!);
        delete payload.identity;
        runs[1]!.identity = canonicalIdentity(
          payload,
          "evleda.sixlayer-regeneration-run-receipt.v2",
        );
      },
    },
    {
      name: "coherently rehashed fabricated board outputs",
      mutate(evidence: Record<string, unknown>) {
        const fabricated = "f".repeat(64);
        const runs = evidence.runs as Record<string, unknown>[];
        for (const run of runs) {
          const outputs = run.outputs as Record<string, unknown>[];
          const board = outputs.find(
            (entry) => entry.path === "robotics-controller-v0.kicad_pcb",
          )!;
          board.sha256 = fabricated;
          const payload = structuredClone(run);
          delete payload.identity;
          run.identity = canonicalIdentity(
            payload,
            "evleda.sixlayer-regeneration-run-receipt.v2",
          );
        }
        evidence.currentBoardSemanticSha256 = fabricated;
      },
    },
    {
      name: "a minimal receipt-shaped object",
      mutate(evidence: Record<string, unknown>) {
        const runs = evidence.runs as Record<string, unknown>[];
        runs[1] = { schemaVersion: "evleda.sixlayer-regeneration-run-receipt.v2" };
      },
    },
    {
      name: "a coherently rehashed receipt CLI digest",
      mutate(evidence: Record<string, unknown>) {
        const run = (evidence.runs as Record<string, unknown>[])[0]!;
        const tools = run.tools as Record<string, Record<string, unknown>>;
        const cli = tools.kicadCli!;
        cli.contentIdentity = {
          ...(cli.contentIdentity as Record<string, unknown>),
          digest: "f".repeat(64),
        };
        const payload = structuredClone(run);
        delete payload.identity;
        run.identity = canonicalIdentity(payload, "evleda.sixlayer-regeneration-run-receipt.v2");
      },
    },
    {
      name: "a coherently rehashed transcript digest",
      mutate(evidence: Record<string, unknown>) {
        const run = (evidence.runs as Record<string, unknown>[])[0]!;
        const command = (run.commands as Record<string, unknown>[])[0]!;
        command.stdout = {
          ...(command.stdout as Record<string, unknown>),
          sha256: "f".repeat(64),
        };
        const payload = structuredClone(run);
        delete payload.identity;
        run.identity = canonicalIdentity(payload, "evleda.sixlayer-regeneration-run-receipt.v2");
      },
    },
    {
      name: "a coherently rehashed nonce and command IDs",
      mutate(evidence: Record<string, unknown>) {
        const run = (evidence.runs as Record<string, unknown>[])[0]!;
        run.nonce = "f".repeat(64);
        for (const command of run.commands as Record<string, unknown>[]) {
          command.commandId = contentIdentity(
            `${String(run.nonce)}\0${String(command.sequence)}\0${String(command.operation)}`,
          ).digest;
        }
        const payload = structuredClone(run);
        delete payload.identity;
        run.identity = canonicalIdentity(payload, "evleda.sixlayer-regeneration-run-receipt.v2");
      },
    },
    {
      name: "a coherently rehashed root binding",
      mutate(evidence: Record<string, unknown>) {
        const run = (evidence.runs as Record<string, unknown>[])[0]!;
        run.rootBinding = {
          ...(run.rootBinding as Record<string, unknown>),
          pathDigest: "f".repeat(64),
        };
        const payload = structuredClone(run);
        delete payload.identity;
        run.identity = canonicalIdentity(payload, "evleda.sixlayer-regeneration-run-receipt.v2");
      },
    },
    {
      name: "a falsified independence boolean",
      mutate(evidence: Record<string, unknown>) {
        (evidence.independence as Record<string, unknown>).distinctNonces = false;
      },
    },
  ])("rejects $name before tool discovery", async ({ mutate }) => {
    const fixture = await syntheticPassingReference({ mutateRegenerationEvidence: mutate });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });
    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      failureCode: "REFERENCE_VALIDATION_STALE",
    });
  });

  it("requires the full 48-net canonical connectivity contract", async () => {
    expect(REFERENCE_KICAD_REQUIRED_NETS).toHaveLength(48);
    const fixture = await syntheticPassingReference({ omitRequiredNet: true });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });
    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      code: "GATE_FAILED",
      failureCode: "REFERENCE_CONNECTIVITY_FAILED",
    });
  });

  it.each([
    {
      name: "semantic contract identity drift",
      mutate(connectivity: Record<string, unknown>) {
        connectivity.requiredNetContractIdentity = {
          ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
          digest: "f".repeat(64),
        };
      },
      failureCode: "REFERENCE_CONNECTIVITY_FAILED",
    },
    {
      name: "raw contract identity drift",
      mutate(connectivity: Record<string, unknown>) {
        connectivity.requiredNetContractContentIdentity = {
          ...REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
          digest: "f".repeat(64),
        };
      },
      failureCode: "REFERENCE_CONNECTIVITY_FAILED",
    },
    {
      name: "contract file binding drift",
      mutate(connectivity: Record<string, unknown>) {
        connectivity.requiredNetContractFile = {
          path: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
          sizeBytes: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY.size,
          sha256: "f".repeat(64),
        };
      },
      failureCode: "REFERENCE_VALIDATION_STALE",
    },
    {
      name: "semantic alias substitution",
      mutate(connectivity: Record<string, unknown>) {
        connectivity.semanticAliasNetNames = [
          Object.keys(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases)[0]!,
        ];
      },
      failureCode: "REFERENCE_CONNECTIVITY_FAILED",
    },
    {
      name: "schematic parser failure",
      mutate(connectivity: Record<string, unknown>) {
        connectivity.schematicNetlistParseError = "synthetic parse failure";
      },
      failureCode: "REFERENCE_CONNECTIVITY_FAILED",
    },
  ])("rejects $name before tool discovery", async ({ mutate, failureCode }) => {
    const fixture = await syntheticPassingReference({ mutateConnectivity: mutate });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });

    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      failureCode,
    });
  });

  it("rejects a schematic-netlist node whose reference is absent from the component set", async () => {
    const fixture = await syntheticPassingReference({
      addUnknownNetlistNodeReference: true,
    });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });

    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      code: "GATE_FAILED",
      failureCode: "REFERENCE_CONNECTIVITY_FAILED",
      details: { unexpectedReferences: [fixture.unexpectedReference] },
    });
  });

  it("rejects coherently swapped selected-component references across PCB, netlist, and BOM", async () => {
    const fixture = await syntheticPassingReference({ swapSelectedRoleReferences: true });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });

    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
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
  });

  it.each([
    ["a missing", { omitPositionReference: true }],
    ["an unexpected", { addUnexpectedPositionReference: true }],
  ] as const)("rejects %s position-export reference before tool discovery", async (_name, options) => {
    const fixture = await syntheticPassingReference(options);
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });

    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      code: "GATE_FAILED",
      failureCode: "REFERENCE_POSITION_PARITY_FAILED",
      details:
        "omitPositionReference" in options
          ? {
              missingReferences: [fixture.positionMutationReference],
              unexpectedReferences: [],
            }
          : {
              missingReferences: [],
              unexpectedReferences: [fixture.unexpectedReference],
            },
    });
  });

  it.each([
    ["duplicate reference", { duplicatePositionReference: true }, "GATE_FAILED"],
    ["unterminated quoted field", { unterminatedPositionCsv: true }, "TOOL_RESULT_INCONCLUSIVE"],
    ["quote inside an unquoted field", { invalidPositionQuote: "mid_field" }, "TOOL_RESULT_INCONCLUSIVE"],
    ["trailing data after a quoted field", { invalidPositionQuote: "trailing_data" }, "TOOL_RESULT_INCONCLUSIVE"],
  ] as const)("rejects a position CSV with a %s", async (_name, options, code) => {
    const fixture = await syntheticPassingReference(options);
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });

    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      code,
      failureCode: "REFERENCE_POSITION_PARITY_FAILED",
    });
  });

  it.each(["dnp", "exclude_from_pos_files"] as const)(
    "accepts a position omission only when the PCB explicitly classifies it as %s",
    async (positionExclusionReason) => {
      const fixture = await syntheticPassingReference({ positionExclusionReason });
      const backend = new ReferenceKicadBackend({
        workRoot: fixture.workRoot,
        referenceDesignRoot: fixture.referenceRoot,
        executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
      });

      await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
        code: "TOOLCHAIN_UNAVAILABLE",
        failureCode: "REFERENCE_TOOLCHAIN_UNAVAILABLE",
      });
    },
  );

  it("retains a DNP footprint in positions when the bound command does not exclude DNP", async () => {
    const fixture = await syntheticPassingReference({
      positionExclusionReason: "dnp",
      positionCommandExcludeDnp: false,
    });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });

    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      code: "TOOLCHAIN_UNAVAILABLE",
      failureCode: "REFERENCE_TOOLCHAIN_UNAVAILABLE",
    });
  });

  it("rejects local footprint bindings that are not declared by fp-lib-table", async () => {
    const fixture = await syntheticPassingReference({ omitFootprintDeclaration: true });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: process.execPath,
    });
    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      failureCode: "REFERENCE_VALIDATION_STALE",
    });
  });

  it("binds verified routing evidence to the exact canonical PCB bytes", async () => {
    const fixture = await syntheticPassingReference({ generatorBoardDigestMismatch: true });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });
    await expect(backend.execute(requestFor("pcb_placement_routing"))).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
      failureCode: "REFERENCE_VALIDATION_STALE",
    });
  });

  it("rejects inconsistent split and aggregate native copper-item counts", async () => {
    const fixture = await syntheticPassingReference({ generatorTrackCountMismatch: true });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });
    await expect(backend.execute(requestFor("pcb_placement_routing"))).rejects.toMatchObject({
      failureCode: "REFERENCE_VALIDATION_STALE",
    });
  });

  it.each([
    {
      name: "pending deterministic evidence",
      mutate(manifest: Record<string, unknown>) {
        (manifest.regeneration as Record<string, unknown>).deterministicEvidencePending = true;
      },
    },
    {
      name: "a candidate-scoped physical qualification caveat",
      mutate(manifest: Record<string, unknown>) {
        const assumptions = manifest.unresolvedAssumptions as Record<string, unknown>[];
        assumptions[0] = { ...assumptions[0], scope: "candidate" };
      },
    },
    {
      name: "an embedded command that disagrees with its bound command log",
      mutate(manifest: Record<string, unknown>) {
        const invocations = manifest.invocations as Record<string, unknown>[];
        invocations[0] = { ...invocations[0], exitCode: 1 };
      },
    },
    {
      name: "a source digest that disagrees with source bindings",
      mutate(manifest: Record<string, unknown>) {
        manifest.sourceDigest = "f".repeat(64);
      },
    },
    {
      name: "a non-passing component metadata attestation",
      mutate(manifest: Record<string, unknown>) {
        const connectivity = manifest.connectivity as Record<string, unknown>;
        const componentMetadata = connectivity.componentMetadata as Record<string, unknown>;
        componentMetadata.status = "fail";
      },
    },
  ])("rejects $name before tool discovery", async ({ mutate }) => {
    const fixture = await syntheticPassingReference({ mutateManifest: mutate });
    const backend = new ReferenceKicadBackend({
      workRoot: fixture.workRoot,
      referenceDesignRoot: fixture.referenceRoot,
      executablePath: path.join(fixture.workRoot, "missing-kicad-cli.exe"),
    });
    await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
      failureCode: "REFERENCE_VALIDATION_STALE",
    });
  });

  it.skipIf(!existsSync(TEST_KICAD_CLI_PATH))(
    "captures source-preserving native netlist, IPC-D-356, and board-statistics views",
    async () => {
      const workspace = await temporaryDirectory("evleda-reference-native-inspection-");
      const projectRoot = path.join(workspace, "project");
      await mkdir(projectRoot);
      for (const name of [
        "robotics-controller-v0.kicad_pro",
        "robotics-controller-v0.kicad_sch",
        "robotics-controller-v0.kicad_pcb",
        "robotics-controller-v0.kicad_dru",
        "sym-lib-table",
        "fp-lib-table",
      ]) {
        await cp(path.join(REFERENCE_ROOT, name), path.join(projectRoot, name));
      }
      await cp(path.join(REFERENCE_ROOT, "symbols"), path.join(projectRoot, "symbols"), {
        recursive: true,
      });
      const schematicPath = path.join(projectRoot, "robotics-controller-v0.kicad_sch");
      const pcbPath = path.join(projectRoot, "robotics-controller-v0.kicad_pcb");
      const before = await Promise.all([readFile(schematicPath), readFile(pcbPath)]);
      const adapter = await KicadCliAdapter.create({
        workspaceRoot: workspace,
        projectRoot,
        executablePath: TEST_KICAD_CLI_PATH,
      });

      const inspected = await adapter.inspectNativeDesign({
        schematicPath,
        pcbPath,
        outputDirectory: path.join(workspace, "inspection"),
      });

      expect(inspected.invocations.map((invocation) => invocation.args.slice(0, 3))).toEqual([
        ["sch", "export", "netlist"],
        ["pcb", "export", "stats"],
        ["pcb", "export", "ipcd356"],
      ]);
      expect([
        inspected.schematicNetlist.relativePath,
        inspected.boardStatistics.relativePath,
        inspected.boardNetlist.relativePath,
      ]).toEqual([
        "schematic-netlist.kicad_net",
        "board-statistics.json",
        "board-netlist.d356",
      ]);
      expect(await Promise.all([readFile(schematicPath), readFile(pcbPath)])).toEqual(before);
    },
    60_000,
  );

  it.skipIf(!existsSync(TEST_KICAD_CLI_PATH))(
    "blocks the checked-in reference until its canonical validation is present, fresh, and passing",
    async () => {
      const workRoot = await temporaryDirectory("evleda-reference-backend-canonical-gate-");
      const backend = new ReferenceKicadBackend({
        workRoot,
        referenceDesignRoot: REFERENCE_ROOT,
        executablePath: TEST_KICAD_CLI_PATH,
      });

      if (!existsSync(VALIDATION_MANIFEST)) {
        await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
          failureCode: "REFERENCE_VALIDATION_MISSING",
        });
        throw new Error(
          "Canonical robotics-controller-v0 validation is missing; the reference is not accepted.",
        );
      }

      const validation = JSON.parse(await readFile(VALIDATION_MANIFEST, "utf8")) as {
        checksPass?: unknown;
      };
      if (validation.checksPass !== true) {
        await expect(backend.execute(requestFor("schematic"))).rejects.toBeInstanceOf(
          ReferenceKicadBackendError,
        );
        throw new Error(
          "Canonical robotics-controller-v0 validation is not passing; partial/dirty reference remains blocked.",
        );
      }

      await expect(backend.execute(requestFor("schematic"))).resolves.toMatchObject({
        schemaVersion: "evleda.kicad-result.v2",
        stage: "schematic",
      });
    },
    120_000,
  );

  it.skipIf(!existsSync(TEST_KICAD_CLI_PATH))(
    "runs all three stages through installed KiCad 10.0.3 and returns source/tool-bound candidate bytes",
    async () => {
      const workRoot = await temporaryDirectory("evleda-reference-backend-real-");
      const backend = new ReferenceKicadBackend({
        workRoot,
        referenceDesignRoot: REFERENCE_ROOT,
        executablePath: TEST_KICAD_CLI_PATH,
      });
      expect(backend.backendId).toBe(REFERENCE_KICAD_BACKEND_ID);

      const schematic = await backend.execute(requestFor("schematic"));
      expect(schematic.artifacts.map((artifact) => artifact.role)).toEqual([
        "project",
        "schematic",
      ]);
      expect(schematic.reports.map((report) => report.kind)).toEqual([
        "erc",
        "schematic_netlist",
        "connectivity",
      ]);

      const pcb = await backend.execute(requestFor("pcb_placement_routing"));
      expect(pcb.artifacts.some((artifact) => artifact.role === "pcb")).toBe(true);
      expect(pcb.artifacts.filter((artifact) => artifact.role === "render")).toHaveLength(2);
      expect(pcb.reports.map((report) => report.kind)).toEqual([
        "drc",
        "schematic_netlist",
        "board_statistics",
        "board_netlist",
        "schematic_parity",
        "connectivity",
        "geometry",
        "pcb_practices",
      ]);
      const pcbPractices = decodeJson(
        pcb.reports.find((report) => report.kind === "pcb_practices")!.content,
      );
      expect(pcbPractices).toMatchObject({
        schemaVersion: REFERENCE_KICAD_REPORT_SCHEMA,
        kind: "pcb_practices",
        validationStatus: "fail",
        releaseAuthorized: false,
        payload: {
          engineeringInputs: {
            practiceCatalog: {
              canonicalIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
            },
          },
          analysis: {
            classification: "analysis-only",
            releaseAuthorized: false,
            outcome: expect.stringMatching(/^(?:fail|review)$/u),
          },
          engineeringSummary: {
            analyzerOutcome: expect.stringMatching(/^(?:fail|review)$/u),
            reviewRequired: true,
            machine: {
              status: "fail",
              gateFailed: true,
              coverageIncomplete: true,
            },
            external: { status: "none" },
            artifactDisposition: "BLOCKED_DIAGNOSTIC",
            manufactureReady: false,
            qualificationAuthorized: false,
            releaseAuthorized: false,
          },
        },
      });

      const manufacturing = await backend.execute(requestFor("manufacturing_package"));
      for (const role of ["bom", "gerber", "drill", "position", "cam_manifest"] as const) {
        expect(manufacturing.artifacts.some((artifact) => artifact.role === role)).toBe(true);
      }
      expect(manufacturing.reports.map((report) => report.kind)).toEqual([
        "drc",
        "schematic_netlist",
        "board_statistics",
        "board_netlist",
        "schematic_parity",
        "bom_parity",
        "bom_export",
        "gerber_export",
        "drill_export",
        "position_export",
        "cam_manifest",
      ]);

      const narrowed = await backend.execute(
        requestFor("schematic", NARROW_PROFILE, NARROW_PROMPT),
      );
      expect(reportDocuments(narrowed)).not.toHaveLength(0);
      for (const document of reportDocuments(narrowed)) {
        expect(document).toMatchObject({
          requestBinding: {
            schemaVersion: REFERENCE_KICAD_REQUEST_BINDING_SCHEMA,
            templateInstantiation: {
              mode: REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
              requestedProfile: {
                profileIdentity: canonicalIdentity(
                  NARROW_PROFILE,
                  REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA,
                ),
                electricalEnvelope: {
                  inputVoltageMv: { minimum: 9_000, maximum: 12_000 },
                  motor: {
                    channels: 2,
                    rmsCurrentMaPerChannel: 250,
                    currentChopMaPerChannel: 1_000,
                  },
                },
              },
            },
          },
          provenance: {
            operation: REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
            topologyGenerationPerformed: false,
            nativeDesignMutationPerformed: false,
            artifactSemantics: "validated-template-copy-not-newly-generated-pcb",
          },
        });
      }

      for (const result of [schematic, pcb, manufacturing, narrowed]) {
        expect(result).toMatchObject({
          sourceRevisionDigest: SOURCE_DIGEST,
          tool: {
            adapter: "kicad_cli",
            version: REFERENCE_KICAD_VERSION,
            executablePath: TEST_KICAD_CLI_PATH,
            executableDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        });
        expect(result.artifacts.every((artifact) => artifact.content.byteLength > 0)).toBe(true);
        expect(
          result.reports.every((report) =>
            report.validationStatus === (report.kind === "pcb_practices" ? "fail" : "pass")
          ),
        ).toBe(true);
        for (const native of result.reports.filter(
          (report) => report.evidenceClass === "kicad_native",
        )) {
          expect(native.authority).toMatchObject({
            kind: "kicad_cli_output",
            tool: {
              adapter: "kicad_cli",
              version: REFERENCE_KICAD_VERSION,
              executableDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            },
            outputIdentity: contentIdentity(native.content),
          });
          expect(native.authority.sourceBindings.length).toBeGreaterThan(0);
        }
        for (const document of reportDocuments(result)) {
          expect(document).toMatchObject({
            schemaVersion: REFERENCE_KICAD_REPORT_SCHEMA,
            validationStatus: document.kind === "pcb_practices" ? "fail" : "pass",
            lifecycle: "candidate",
            releaseAuthorized: false,
            sourceRevisionDigest: SOURCE_DIGEST,
            executable: {
              kind: "kicad-cli",
              version: REFERENCE_KICAD_VERSION,
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
              capabilityHelpSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            },
            authority: {
              kind: "evleda_analyzer",
              analyzerId: expect.stringMatching(/^evleda\.reference-kicad\./u),
              tool: { adapter: "evleda" },
              inputBindings: expect.arrayContaining([
                expect.objectContaining({ kind: "native_report" }),
                expect.objectContaining({ kind: "source" }),
              ]),
            },
          });
        }
      }

      const cam = manufacturing.artifacts.find((artifact) => artifact.role === "cam_manifest");
      expect(cam).toBeDefined();
      expect(decodeJson(cam!.content)).toMatchObject({
        schemaVersion: REFERENCE_KICAD_CAM_SCHEMA,
        classification: "candidate",
        lifecycle: "candidate",
        releaseAuthorized: false,
        sourceRevisionDigest: SOURCE_DIGEST,
        requestBinding: {
          schemaVersion: REFERENCE_KICAD_REQUEST_BINDING_SCHEMA,
        },
        provenance: {
          operation: REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE,
          topologyGenerationPerformed: false,
          nativeDesignMutationPerformed: false,
          artifactSemantics: "validated-template-copy-not-newly-generated-pcb",
        },
      });
      expect(await readdir(workRoot)).toEqual([]);
    },
    180_000,
  );

  it.skipIf(!existsSync(TEST_KICAD_CLI_PATH))(
    "rejects a source edit made after canonical validation instead of regenerating a pass",
    async () => {
      if (!existsSync(VALIDATION_MANIFEST)) {
        throw new Error(
          "Canonical robotics-controller-v0 validation is missing; stale-source integration cannot be proven.",
        );
      }
      const fixtureRoot = await temporaryDirectory("evleda-reference-backend-stale-");
      const referenceRoot = path.join(fixtureRoot, "reference");
      const workRoot = path.join(fixtureRoot, "work");
      await Promise.all([cp(REFERENCE_ROOT, referenceRoot, { recursive: true }), mkdir(workRoot)]);
      await writeFile(
        path.join(referenceRoot, "robotics-controller-v0.kicad_sch"),
        `${await readFile(path.join(referenceRoot, "robotics-controller-v0.kicad_sch"), "utf8")}\n`,
        "utf8",
      );
      const backend = new ReferenceKicadBackend({
        workRoot,
        referenceDesignRoot: referenceRoot,
        executablePath: TEST_KICAD_CLI_PATH,
      });

      await expect(backend.execute(requestFor("schematic"))).rejects.toMatchObject({
        name: "ReferenceKicadBackendError",
        code: "DIGEST_MISMATCH",
        failureCode: "REFERENCE_VALIDATION_STALE",
      });
    },
    60_000,
  );
});

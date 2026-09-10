import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { ValidationStatus } from "../../src/domain/types.js";
import {
  REFERENCE_CONNECTIVITY_ANALYZER_ID,
  REFERENCE_CONNECTIVITY_ANALYZER_TOOL,
  REFERENCE_KICAD_ANALYZER_TOOLS,
  REFERENCE_KICAD_REPORT_SCHEMA,
  referenceKicadRequestBinding,
} from "../../src/integrations/reference-kicad-backend.js";
import {
  PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
  analyzeKicadPcbPractices,
} from "../../src/integrations/pcb-practice-analyzer.js";
import {
  KICAD_NATIVE_REPORT_COMMAND_PREFIXES,
  buildKicadPcbEngineeringDecisionSummary,
  isKicadNativeReportKind,
  type KicadBackendReport,
  type KicadBackendRequest,
  type KicadGeneratedArtifact,
  type KicadNativeReport,
  type KicadNativeReportKind,
  type KicadNativeToolIdentity,
  type KicadReportKind,
} from "../../src/workflow/contracts.js";
/*
 * This fixture intentionally consumes the production discriminator instead of
 * maintaining a second kind list that could reintroduce provenance drift.
 */

export const TEST_KICAD_TOOL: KicadNativeToolIdentity = Object.freeze({
  name: "kicad-cli-test-double",
  version: "10.0.3-test",
  adapter: "kicad_cli",
  executablePath: "C:/fixtures/kicad-cli.exe",
  executableDigest: contentIdentity("kicad-cli-test-double:10.0.3").digest,
  capabilityProfile: "isolated-test-double:kicad-result-v2",
});

/** A complete, in-bounds, 45-degree-only board for synthetic happy paths. */
export const CLEAN_MINIMAL_KICAD_PCB = new TextEncoder().encode([
  "(kicad_pcb",
  `  (version ${PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS[0]})`,
  '  (generator "pcbnew")',
  "  (layers",
  '    (0 "F.Cu" signal)',
  '    (4 "In1.Cu" signal)',
  '    (6 "In2.Cu" power)',
  '    (8 "In3.Cu" power)',
  '    (10 "In4.Cu" signal)',
  '    (2 "B.Cu" signal)',
  '    (25 "Edge.Cuts" user)',
  "  )",
  '  (net 1 "CLEAN_SIGNAL")',
  '  (gr_line (start 0 0) (end 60 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "clean-edge-1"))',
  '  (gr_line (start 60 0) (end 60 45) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "clean-edge-2"))',
  '  (gr_line (start 60 45) (end 0 45) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "clean-edge-3"))',
  '  (gr_line (start 0 45) (end 0 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "clean-edge-4"))',
  '  (segment (start 5 5) (end 10 5) (width 0.2) (layer "F.Cu") (net 1) (uuid "clean-route-1"))',
  '  (segment (start 10 5) (end 15 10) (width 0.2) (layer "F.Cu") (net 1) (uuid "clean-route-2"))',
  ")",
  "",
].join("\n"));

const nativeKinds = (
  stage: KicadBackendRequest["stage"],
): readonly KicadNativeReport["kind"][] =>
  stage === "schematic"
    ? ["erc", "schematic_netlist"]
    : ["drc", "schematic_netlist", "board_statistics", "board_netlist"];

const nativeCommand = (kind: KicadNativeReport["kind"]): readonly string[] => {
  const extension =
    kind === "schematic_netlist"
      ? "kicad_net"
      : kind === "board_netlist"
        ? "d356"
        : "json";
  return [
    ...KICAD_NATIVE_REPORT_COMMAND_PREFIXES[kind],
    "--output",
    `fixture-${kind}.${extension}`,
  ];
};

const nativeInputsFor = (
  kind: KicadReportKind,
  native: ReadonlyMap<KicadReportKind, KicadNativeReport>,
): readonly KicadNativeReport[] => {
  const required =
    kind === "connectivity" || kind === "bom_parity"
      ? ["schematic_netlist", "board_netlist"]
      : kind === "pcb_practices"
        ? ["drc", "board_statistics"]
      : kind === "geometry"
        ? ["board_statistics"]
        : ["drc"];
  return required
    .map((candidate) => native.get(candidate as KicadReportKind))
    .filter((report): report is KicadNativeReport => report !== undefined);
};

export interface TestKicadReportsOptions {
  readonly request: KicadBackendRequest;
  readonly sourceRevisionDigest?: string;
  readonly artifacts: readonly KicadGeneratedArtifact[];
  readonly reportKinds: readonly KicadReportKind[];
  readonly omitKind?: KicadReportKind;
  readonly statusFor?: (kind: KicadReportKind) => ValidationStatus;
  readonly contentFor?: (kind: KicadReportKind) => Uint8Array;
}

export const testKicadReports = (
  options: TestKicadReportsOptions,
): readonly KicadBackendReport[] => {
  const sourceRevisionDigest =
    options.sourceRevisionDigest ?? options.request.expectedSourceRevisionDigest;
  const sourcePcb = options.artifacts.filter((artifact) => artifact.role === "pcb");
  const sourceBindings =
    options.request.stage === "pcb_placement_routing" && sourcePcb.length === 1
      ? [{
          logicalName: "fixture/source.kicad_pcb",
          identity: contentIdentity(sourcePcb[0]!.content),
        }]
      : [{
          logicalName: "fixture/source.kicad_sch",
          identity: contentIdentity(`fixture-source:${sourceRevisionDigest}`),
        }];
  const native = new Map<KicadReportKind, KicadNativeReport>();
  for (const kind of nativeKinds(options.request.stage)) {
    if (kind === options.omitKind) continue;
    const content = new TextEncoder().encode(
      kind === "schematic_netlist"
        ? `fixture-netlist:${sourceRevisionDigest}`
        : `native:${kind}:${sourceRevisionDigest}\n`,
    );
    native.set(kind, {
      kind,
      logicalName: `reports/${options.request.stage}-native-${kind}.bin`,
      mediaType: "application/octet-stream",
      content,
      sourceRevisionDigest,
      validationStatus: options.statusFor?.(kind) ?? "pass",
      evidenceClass: "kicad_native",
      authority: {
        kind: "kicad_cli_output",
        tool: TEST_KICAD_TOOL,
        command: nativeCommand(kind),
        outputIdentity: contentIdentity(content),
        sourceBindings,
      },
    });
  }

  const reports: KicadBackendReport[] = [...native.values()];
  for (const kind of options.reportKinds) {
    if (kind === options.omitKind || isKicadNativeReportKind(kind)) continue;
    const boundNative = nativeInputsFor(kind, native);
    const analyzerId = kind === "connectivity"
      ? REFERENCE_CONNECTIVITY_ANALYZER_ID
      : kind === "pcb_practices"
        ? REFERENCE_KICAD_ANALYZER_TOOLS.pcb_practices.capabilityProfile
        : `test.evleda.${kind.replaceAll("_", "-")}.v2`;
    const analyzerTool = kind === "connectivity"
      ? REFERENCE_CONNECTIVITY_ANALYZER_TOOL
      : kind === "pcb_practices"
        ? REFERENCE_KICAD_ANALYZER_TOOLS.pcb_practices
        : {
            name: `EvlEDA ${kind} test analyzer`,
            version: "1.0.0-test",
            adapter: "evleda" as const,
            capabilityProfile: analyzerId,
          };
    const pcbArtifact = kind === "pcb_practices"
      ? options.artifacts.filter((artifact) => artifact.role === "pcb")
      : [];
    if (kind === "pcb_practices" && (pcbArtifact.length !== 1 || options.request.pcbEngineering === null)) {
      throw new Error("pcb_practices fixture requires one PCB artifact and exact request engineering inputs.");
    }
    const artifactInputs = kind === "pcb_practices" ? pcbArtifact : options.artifacts;
    const inputBindings = [
      ...boundNative.map((report) => ({
        kind: "native_report" as const,
        logicalName: report.logicalName,
        identity: contentIdentity(report.content),
      })),
      ...artifactInputs.map((artifact) => ({
        kind: "artifact" as const,
        logicalName: artifact.logicalName,
        identity: contentIdentity(artifact.content),
      })),
      ...(kind === "pcb_practices"
        ? [
            {
              kind: "artifact" as const,
              logicalName: options.request.pcbEngineering!.layoutPlan.logicalName,
              identity: options.request.pcbEngineering!.layoutPlan.contentIdentity,
            },
            ...[
              options.request.pcbEngineering!.analyzerProfile,
              options.request.pcbEngineering!.practiceCatalog,
              options.request.pcbEngineering!.routeQualityPolicy,
              options.request.pcbEngineering!.routeQualityRuleDeck,
              options.request.pcbEngineering!.proofFixturePolicy,
              ...(options.request.pcbEngineering!.engineeringConstraintBinding === null
                ? []
                : [options.request.pcbEngineering!.engineeringConstraintBinding]),
            ].map((snapshot) => ({
              kind: "artifact" as const,
              logicalName: snapshot.logicalName,
              identity: snapshot.contentIdentity,
            })),
          ]
        : []),
      ...sourceBindings.map((binding) => ({ kind: "source" as const, ...binding })),
    ];
    const authority = {
      kind: "evleda_analyzer" as const,
      analyzerId,
      tool: analyzerTool,
      inputBindings,
    };
    let validationStatus: ValidationStatus = options.statusFor?.(kind) ?? "pass";
    let content: Uint8Array;
    if (kind === "pcb_practices") {
      const engineering = options.request.pcbEngineering!;
      const analysis = analyzeKicadPcbPractices(
        pcbArtifact[0]!.content,
        engineering.analyzerProfile.document,
        { sourcePath: pcbArtifact[0]!.logicalName },
      );
      const engineeringSummary = buildKicadPcbEngineeringDecisionSummary(
        analysis,
        engineering.engineeringConstraintBinding?.document ?? null,
      );
      validationStatus =
        options.statusFor?.(kind) ??
        (engineeringSummary.machine.status === "pass" ? "pass" : "fail");
      content = new TextEncoder().encode(`${canonicalJson({
        schemaVersion: REFERENCE_KICAD_REPORT_SCHEMA,
        kind,
        validationStatus,
        classification: "candidate-validation",
        lifecycle: "candidate",
        releaseAuthorized: false,
        sourceRevisionDigest,
        requestBinding: referenceKicadRequestBinding(options.request),
        authority,
        payload: {
          engineeringInputs: {
            layoutPlan: {
              logicalName: engineering.layoutPlan.logicalName,
              contentIdentity: engineering.layoutPlan.contentIdentity,
            },
            analyzerProfile: {
              logicalName: engineering.analyzerProfile.logicalName,
              contentIdentity: engineering.analyzerProfile.contentIdentity,
              canonicalIdentity: engineering.analyzerProfile.canonicalIdentity,
            },
            practiceCatalog: {
              logicalName: engineering.practiceCatalog.logicalName,
              contentIdentity: engineering.practiceCatalog.contentIdentity,
              canonicalIdentity: engineering.practiceCatalog.canonicalIdentity,
            },
            routeQualityPolicy: {
              logicalName: engineering.routeQualityPolicy.logicalName,
              contentIdentity: engineering.routeQualityPolicy.contentIdentity,
              canonicalIdentity: engineering.routeQualityPolicy.canonicalIdentity,
              captureIdentity: engineering.routeQualityPolicy.captureIdentity,
            },
            routeQualityRuleDeck: {
              logicalName: engineering.routeQualityRuleDeck.logicalName,
              contentIdentity: engineering.routeQualityRuleDeck.contentIdentity,
              canonicalIdentity: engineering.routeQualityRuleDeck.canonicalIdentity,
            },
            proofFixturePolicy: {
              logicalName: engineering.proofFixturePolicy.logicalName,
              contentIdentity: engineering.proofFixturePolicy.contentIdentity,
              canonicalIdentity: engineering.proofFixturePolicy.canonicalIdentity,
            },
            engineeringConstraintBinding:
              engineering.engineeringConstraintBinding === null
                ? null
                : {
                    logicalName: engineering.engineeringConstraintBinding.logicalName,
                    contentIdentity:
                      engineering.engineeringConstraintBinding.contentIdentity,
                    canonicalIdentity:
                      engineering.engineeringConstraintBinding.canonicalIdentity,
                    compiledConstraintSetIdentity:
                      engineering.engineeringConstraintBinding.document
                        .compiledConstraintSetIdentity,
                  },
          },
          analysisIdentity: canonicalIdentity(analysis, analysis.schemaVersion),
          analysis,
          engineeringSummary,
        },
      })}\n`);
    } else {
      const suppliedContent =
        options.contentFor?.(kind) ??
        new TextEncoder().encode(`{"kind":"${kind}","status":"pass"}\n`);
      content = suppliedContent;
      try {
        const document = JSON.parse(new TextDecoder().decode(suppliedContent)) as unknown;
        if (typeof document === "object" && document !== null && !Array.isArray(document)) {
          content = new TextEncoder().encode(
            `${JSON.stringify({
              ...(document as Readonly<Record<string, unknown>>),
              kind,
              validationStatus,
              sourceRevisionDigest,
              authority,
            })}\n`,
          );
        }
      } catch {
        // A fixture may intentionally supply opaque analyzer bytes.
      }
    }
    reports.push({
      kind,
      logicalName: `reports/${options.request.stage}-${kind}.json`,
      mediaType: "application/json",
      content,
      sourceRevisionDigest,
      validationStatus,
      evidenceClass: "evleda_check",
      authority: {
        kind: "evleda_analyzer",
        analyzerId,
        tool: analyzerTool,
        inputBindings,
      },
    });
  }
  return reports;
};

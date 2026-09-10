import { describe, expect, it } from "vitest";

import { contentIdentity } from "../../src/core/canonical.js";
import { parseRequirements } from "../../src/core/requirements.js";
import { runKicadBackend } from "../../src/generators/backend-runner.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import type {
  CandidateStageContext,
  KicadBackendReport,
  KicadBackendRequest,
  KicadBackendResult,
  KicadGenerationBackend,
} from "../../src/workflow/contracts.js";
import { TEST_KICAD_TOOL, testKicadReports } from "../helpers/kicad-reports.js";

const requirements = parseRequirements(
  "Build two brushed motors for a 7-16.8 V supply at 0.5 A RMS per channel with USB, CAN, UART, I2C, SPI, two quadrature encoders, and SWD.",
).document;

const contextFor = (backend: KicadGenerationBackend): CandidateStageContext => ({
  projectId: "project_report_provenance",
  runId: "run_report_provenance",
  designRevisionId: "revision_report_provenance",
  requirements,
  profile: ROBOTICS_CONTROLLER_V0,
  upstream: [],
  upstreamSourceRevisionBindings: [],
  kicadBackend: backend,
});

const executeWith = async (
  mutate: (
    reports: readonly KicadBackendReport[],
    request: KicadBackendRequest,
  ) => readonly KicadBackendReport[] = (reports) => reports,
) => {
  const backend: KicadGenerationBackend = {
    backendId: "report-provenance-test-backend",
    execute: async (request): Promise<KicadBackendResult> => {
      const reports = testKicadReports({
        request,
        artifacts: [],
        reportKinds: ["erc", "connectivity"],
      });
      return {
        schemaVersion: "evleda.kicad-result.v2",
        stage: request.stage,
        sourceRevisionDigest: request.expectedSourceRevisionDigest,
        tool: TEST_KICAD_TOOL,
        artifacts: [],
        reports: mutate(reports, request),
      };
    },
  };
  return runKicadBackend({
    stage: "schematic",
    context: contextFor(backend),
    profile: ROBOTICS_CONTROLLER_V0,
    exactInputs: [requirements.identity],
    initialArtifacts: [],
    initialBlockers: [],
    requiredArtifactRoles: [],
    requiredReports: ["erc", "connectivity"],
  });
};

describe("KiCad backend report provenance", () => {
  it("keeps direct CLI bytes native and records derived connectivity under its analyzer", async () => {
    const result = await executeWith();

    expect(result.blockers).toEqual([]);
    const native = result.evidence.filter((entry) => entry.evidenceClass === "kicad_native");
    const derived = result.evidence.filter((entry) => entry.evidenceClass === "evleda_check");
    expect(native.map((entry) => entry.rawArtifactLogicalName)).toEqual([
      "reports/schematic-native-erc.bin",
      "reports/schematic-native-schematic_netlist.bin",
    ]);
    expect(native.every((entry) => entry.tool.adapter === "kicad_cli")).toBe(true);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      parsedArtifactLogicalName: "reports/schematic-connectivity.json",
      tool: {
        adapter: "evleda",
        capabilityProfile: "evleda.reference-kicad.connectivity.v2",
      },
    });
    const connectivity = result.artifacts.find(
      (artifact) => artifact.logicalName === "reports/schematic-connectivity.json",
    );
    const netlist = result.artifacts.find(
      (artifact) => artifact.logicalName === "reports/schematic-native-schematic_netlist.bin",
    );
    expect(connectivity?.derivedFrom).toEqual([
      "reports/schematic-native-schematic_netlist.bin",
    ]);
    expect(connectivity?.exactInputs).toContainEqual(netlist?.identity);
  });

  it("rejects a derived report relabeled as native and emits no false native claim", async () => {
    const result = await executeWith((reports) =>
      reports.map((report) =>
        report.kind !== "connectivity"
          ? report
          : ({
              ...report,
              evidenceClass: "kicad_native",
              authority: {
                kind: "kicad_cli_output",
                tool: TEST_KICAD_TOOL,
                command: ["sch", "erc", "--output", "forged.json"],
                outputIdentity: contentIdentity(report.content),
                sourceBindings:
                  report.evidenceClass === "evleda_check"
                    ? report.authority.inputBindings
                        .filter((binding) => binding.kind === "source")
                        .map(({ logicalName, identity }) => ({ logicalName, identity }))
                    : [],
              },
            } as unknown as KicadBackendReport),
      ),
    );

    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["KICAD_REPORT_AUTHORITY_INVALID", "KICAD_REPORT_MISSING"]),
    );
    expect(
      result.evidence.some(
        (entry) => entry.rawArtifactLogicalName === "reports/schematic-connectivity.json",
      ),
    ).toBe(false);
  });

  it("rejects missing or mismatched native authority bindings", async () => {
    const result = await executeWith((reports) =>
      reports.map((report) => {
        if (report.kind !== "connectivity" || report.evidenceClass !== "evleda_check") {
          return report;
        }
        return {
          ...report,
          authority: {
            ...report.authority,
            inputBindings: report.authority.inputBindings.map((binding) =>
              binding.kind === "native_report"
                ? { ...binding, identity: contentIdentity("wrong-native-report") }
                : binding,
            ),
          },
        };
      }),
    );

    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["KICAD_REPORT_BINDING_INVALID", "KICAD_REPORT_MISSING"]),
    );
    expect(
      result.evidence.some(
        (entry) => entry.parsedArtifactLogicalName === "reports/schematic-connectivity.json",
      ),
    ).toBe(false);
  });

  it("fails closed when a v2 report omits its provenance discriminant and authority", async () => {
    const result = await executeWith((reports) =>
      reports.map((report) =>
        report.kind === "connectivity"
          ? ({
              kind: report.kind,
              logicalName: report.logicalName,
              mediaType: report.mediaType,
              content: report.content,
              sourceRevisionDigest: report.sourceRevisionDigest,
              validationStatus: report.validationStatus,
            } as unknown as KicadBackendReport)
          : report,
      ),
    );

    expect(result.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["KICAD_REPORT_AUTHORITY_INVALID", "KICAD_REPORT_MISSING"]),
    );
    expect(
      result.evidence.some(
        (entry) => entry.parsedArtifactLogicalName === "reports/schematic-connectivity.json",
      ),
    ).toBe(false);
  });

  it("rejects legacy v1 results without minting evidence from their payload", async () => {
    const backend: KicadGenerationBackend = {
      backendId: "legacy-result-test-backend",
      execute: async (request): Promise<KicadBackendResult> => {
        const reports = testKicadReports({
          request,
          artifacts: [],
          reportKinds: ["erc", "connectivity"],
        });
        return {
          schemaVersion: "evleda.kicad-result.v1",
          stage: request.stage,
          sourceRevisionDigest: request.expectedSourceRevisionDigest,
          tool: TEST_KICAD_TOOL,
          artifacts: [],
          reports,
        } as unknown as KicadBackendResult;
      },
    };
    const result = await runKicadBackend({
      stage: "schematic",
      context: contextFor(backend),
      profile: ROBOTICS_CONTROLLER_V0,
      exactInputs: [requirements.identity],
      initialArtifacts: [],
      initialBlockers: [],
      requiredArtifactRoles: [],
      requiredReports: ["erc", "connectivity"],
    });

    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      "KICAD_BACKEND_RESULT_INVALID",
    );
    expect(result.evidence).toEqual([]);
    expect(result.artifacts.every((artifact) => artifact.validationStatus === "fail")).toBe(true);
  });
});

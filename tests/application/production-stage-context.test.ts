import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createProductionApplicationService,
  resolveProductionApplicationPaths,
} from "../../src/application/factory.js";
import { contentIdentity } from "../../src/core/canonical.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import { createApprovedRun } from "./helpers.js";

const REPOSITORY_ROOT = path.resolve(".");
const REFERENCE_ROOT = path.join(
  REPOSITORY_ROOT,
  "reference-designs",
  "robotics-controller-v0",
);
const KICAD_CLI = "D:\\Codex-Recovery\\KiCad\\10.0\\bin\\kicad-cli.exe";
const ARM_GCC_ROOT =
  "D:\\Codex-Recovery\\tools\\arm-gnu-toolchain-14.2.rel1-mingw-w64-i686-arm-none-eabi";

const roots: string[] = [];

const prepareReferenceCopy = async (root: string): Promise<string> => {
  const referenceRoot = path.join(root, "reference");
  await cp(REFERENCE_ROOT, referenceRoot, { recursive: true, force: false, errorOnExist: true });
  const validationPath = path.join(referenceRoot, "validation", "reference-validation.json");
  const validation = JSON.parse(await readFile(validationPath, "utf8")) as Record<string, unknown>;
  expect(validation.checksPass).toBe(true);
  expect(validation.lifecycle).toBe("candidate");
  expect(validation.releaseAuthorized).toBe(false);
  return referenceRoot;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("honest production stage-context composition", () => {
  it(
    "provisions real evidence and persists only the expected deterministic component blockers",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "evleda-real-production-context-"));
      roots.push(root);
      const referenceRoot = await prepareReferenceCopy(root);
      const evidenceRoot = path.join(referenceRoot, "evidence");
      const trustRoot = path.join(evidenceRoot, "trust", "reference-context-trust-root.v1.json");
      const trustIdentity = contentIdentity(await readFile(trustRoot));
      const environment = {
        ...process.env,
        EVLEDA_DATA_DIR: path.join(root, "data"),
        EVLEDA_WORKSPACE_ROOT: path.join(root, "data", "workspaces"),
        EVLEDA_KICAD_WORK_ROOT: path.join(root, "data", "kicad-work"),
        EVLEDA_REFERENCE_DESIGN_ROOT: referenceRoot,
        EVLEDA_STAGE_CONTEXT_SNAPSHOT: path.join(
          evidenceRoot,
          "reference-stage-context.v1.json",
        ),
        EVLEDA_STAGE_CONTEXT_SOURCE_ROOT: evidenceRoot,
        EVLEDA_STAGE_CONTEXT_TRUST_ROOT: trustRoot,
        EVLEDA_STAGE_CONTEXT_TRUST_ROOT_SHA256: trustIdentity.digest,
        EVLEDA_STAGE_CONTEXT_TRUST_ROOT_SIZE: String(trustIdentity.size),
        EVLEDA_KICAD_CLI: KICAD_CLI,
        EVLEDA_ARM_GCC_ROOT: ARM_GCC_ROOT,
        EVLEDA_FIRMWARE_BUILD_ROOT: path.join(root, "firmware-build"),
      };
      const paths = resolveProductionApplicationPaths(environment, REPOSITORY_ROOT);
      expect(paths.sourceRoot).toBe(evidenceRoot);
      expect(paths.kicadExecutableCandidates).toEqual([KICAD_CLI]);

      const service = await createProductionApplicationService({ paths, environment });
      await service.initialize();
      const approved = await createApprovedRun(service);
      const status = await service.resumeRun({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        idempotencyKey: "real-production-stage-context-resume-v1",
      });

      expect(status.run.state).toBe("blocked");
      expect(status.currentStage).toBe("component_selection");
      expect(status.run.attempts.system_architecture.at(-1)?.state).toBe("succeeded");
      expect(status.run.attempts.component_selection.at(-1)?.state).toBe("blocked");
      expect(status.run.attempts.schematic).toEqual([]);

      const expectedCodes = [
        "PART_UNAVAILABLE",
        ...Array.from({ length: ROBOTICS_CONTROLLER_V0.components.length }, () =>
          "PIN_PAD_MAPPING_MISMATCH",
        ),
        ...Array.from({ length: 5 }, () => "GATE_FAILED"),
      ].sort();
      expect(status.blockers.map((blocker) => blocker.code).sort()).toEqual(expectedCodes);
      expect(
        status.blockers
          .filter((blocker) => blocker.code !== "GATE_FAILED")
          .every((blocker) => blocker.retryable),
      ).toBe(true);
      expect(
        status.blockers
          .filter((blocker) => blocker.code === "GATE_FAILED")
          .every((blocker) => !blocker.retryable),
      ).toBe(true);
      expect(status.blockers.find((blocker) => blocker.code === "PART_UNAVAILABLE")?.message).toContain(
        "LMR51420XFDDCR availability is not_available",
      );
      expect(
        status.blockers.some((blocker) => blocker.code === "COMPONENT_LIFECYCLE_UNACCEPTABLE"),
      ).toBe(false);
      for (const component of ROBOTICS_CONTROLLER_V0.components) {
        expect(
          status.blockers.some(
            (blocker) =>
              blocker.code === "PIN_PAD_MAPPING_MISMATCH" &&
              blocker.message.includes(component.partNumber),
          ),
        ).toBe(true);
      }
      expect(
        status.blockers.some((blocker) =>
          [
            "EVIDENCE_MISSING",
            "EVIDENCE_STALE",
            "DIGEST_MISMATCH",
            "POLICY_DENIED",
            "TOOLCHAIN_UNAVAILABLE",
            "TOOLCHAIN_UNSUPPORTED",
            "TOOL_RESULT_INCONCLUSIVE",
          ].includes(blocker.code),
        ),
      ).toBe(false);

      const persisted = await service.getRunStatus({ runId: approved.run.id });
      expect(persisted.blockers).toEqual(status.blockers);
      expect(persisted.run.attempts.component_selection.at(-1)?.inputManifest).toEqual(
        status.run.attempts.component_selection.at(-1)?.inputManifest,
      );
    },
    180_000,
  );
});

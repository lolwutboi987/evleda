import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { canonicalJson } from "../core/canonical.js";
import { serializePcbDesignCompilationBundle } from "../harness/pcb-design-compilation-bundle.js";
import { captureFreshProjectCheckpointGuard, assertFreshProjectCheckpointGuardCurrent, refreshFreshProjectCheckpointGuardAfterOwnedClose, type FreshProject } from "../harness/fresh-project.js";
import { verifyFreshNetClassSemanticAuthority } from "../harness/fresh-clearance-evidence.js";
import { freshBoardSerializationsEqual } from "../harness/fresh-board-serialization.js";
import type { KicadMcpSession } from "../integrations/kicad-mcp-session.js";
import type { KicadToolboxFreshPreparation } from "./toolbox-fresh-preparation.js";

async function readArtifact(file: string, limit: number): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error("Checkpoint artifact must be a bounded ordinary unshared file.");
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || bytes.length !== after.size || after.isSymbolicLink() || after.nlink !== 1) throw new Error("Checkpoint artifact changed during read.");
  return bytes;
}

/** Preserve saved candidates, not design acceptance. Only the serialized host invokes this lifecycle. */
export function createFreshToolboxCheckpointLifecycle(input: {
  project: FreshProject; preparation: KicadToolboxFreshPreparation; session: KicadMcpSession;
}) {
  const { project, preparation, session } = input;
  const bundleBytes = serializePcbDesignCompilationBundle(preparation.bundle);
  const operation = { project, compilationBundle: preparation.bundle, kicad: preparation.kicadIdentity };
  return createToolboxSavedCheckpointLifecycle({ project, session, bundleBytes, bundlePath: preparation.bundlePath,
    reportPath: preparation.reportPath, verifySemantics: () => verifyFreshNetClassSemanticAuthority(preparation.netClassSemanticAuthority, operation),
    expectedReport: () => ({ schemaVersion: "evleda.toolbox-fresh-preparation-report.v1", status: "needs_review",
      workflow: { kind: "generic", bundleRef: preparation.bundleRef, bundlePath: preparation.bundlePath }, projectPath: project.projectPath,
      native: { kicad: preparation.kicadIdentity }, preparation: { netClassMaterialization: preparation.netClassMaterialization,
        netClassSemanticAuthority: preparation.netClassSemanticAuthority, netClassPreparationEvidence: preparation.netClassPreparationEvidence,
        preparedSourceAuthority: preparation.preparedSourceAuthority } }) });
}

/** Shared lifecycle mechanics; authentication and expected report semantics remain family-specific host capabilities. */
export function createToolboxSavedCheckpointLifecycle(input: {
  project: FreshProject; session: KicadMcpSession; bundleBytes: Uint8Array; bundlePath: string; reportPath: string;
  verifySemantics: () => Promise<unknown>; expectedReport: () => Record<string, unknown>;
}) {
  const { project, session, bundlePath, reportPath, verifySemantics, expectedReport } = input;
  const bundleBytes = Buffer.from(input.bundleBytes);
  return Object.freeze({
    recordRecoveryRequired: (reason: string) => project.recordUnsafeTerminal(reportPath, reason),
    prepareCheckpoint: async (): Promise<() => Promise<void>> => {
      const guard = await captureFreshProjectCheckpointGuard(project);
      const saved = await readArtifact(project.pcbPath, 64 * 1024 * 1024);
      const live = await session.readActivePcbSource(project.pcbPath);
      if (!freshBoardSerializationsEqual(live, saved.toString("utf8"))) throw new Error("Live PCB differs from saved source; checkpoint refused.");
      await verifySemantics();
      if (!(await readArtifact(bundlePath, 8 * 1024 * 1024)).equals(bundleBytes)) throw new Error("Design bundle changed before checkpoint.");
      const previousReport = await readArtifact(reportPath, 16 * 1024 * 1024);
      const previous = JSON.parse(previousReport.toString("utf8")) as Record<string, unknown>;
      const expected = structuredClone(expectedReport());
      const { assurance, ...record } = previous;
      if (typeof assurance !== "string" || canonicalJson(record) !== canonicalJson(expected)) throw new Error("Preparation report changed or differs from this session.");
      await assertFreshProjectCheckpointGuardCurrent(project, guard);
      let committed = false;
      return async () => {
        if (committed) throw new Error("Checkpoint publication was already consumed.");
        committed = true;
        // The owning server calls this only after confirmed native teardown.
        // KiCad may rewrite identical .pro bytes while closing its editor.
        const closedGuard = await refreshFreshProjectCheckpointGuardAfterOwnedClose(project, guard);
        if (!(await readArtifact(reportPath, 16 * 1024 * 1024)).equals(previousReport)
          || !(await readArtifact(bundlePath, 8 * 1024 * 1024)).equals(bundleBytes)) throw new Error("Checkpoint artifacts changed during teardown.");
        const temporary = `${reportPath}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ ...expected,
          assurance: "Saved candidate checkpoint after confirmed native teardown. Pending design requirements and findings remain unverified; this is not design acceptance." }, null, 2)}\n`, { flag: "wx" });
        await assertFreshProjectCheckpointGuardCurrent(project, closedGuard);
        if (!(await readArtifact(reportPath, 16 * 1024 * 1024)).equals(previousReport)) throw new Error("Preparation report changed before publication.");
        await rename(temporary, reportPath);
        await project.checkpointAfterReport(reportPath, "needs_review", { sourceGuard: closedGuard });
      };
    },
  });
}

import { serializePcbPlaneCompilationBundle } from "../harness/pcb-design-plane-bundle.js";
import { readFile } from "node:fs/promises";
import { verifyFreshPlaneNetClassSemanticAuthority } from "../harness/fresh-plane-netclasses.js";
import type { PlaneFreshProject } from "../harness/fresh-project.js";
import type { KicadMcpSession } from "../integrations/kicad-mcp-session.js";
import { assertKicadToolboxPlanePreparation, planePreparationReportBody, type KicadToolboxPlanePreparation } from "./toolbox-plane-preparation.js";
import { createToolboxSavedCheckpointLifecycle } from "./toolbox-fresh-checkpoint.js";

export function createPlaneToolboxCheckpointLifecycle(input: {
  project: PlaneFreshProject; preparation: KicadToolboxPlanePreparation; session: KicadMcpSession;
}) {
  assertKicadToolboxPlanePreparation(input.preparation);
  const { project, preparation, session } = input;
  return createToolboxSavedCheckpointLifecycle({ project, session,
    bundleBytes: serializePcbPlaneCompilationBundle(preparation.bundle), bundlePath: preparation.bundlePath, reportPath: preparation.reportPath,
    verifySemantics: async () => {
      preparation.boardFeatureState?.verify(await readFile(project.pcbPath, "utf8"), preparation.dependencies.libraryResolver);
      const result = await verifyFreshPlaneNetClassSemanticAuthority(preparation.netClassSemanticAuthority,
        { project, compilationBundle: preparation.bundle, kicad: preparation.kicadIdentity,captureNativeNetlist:preparation.captureNativeNetlist,
          assertLibrarySources:()=>assertKicadToolboxPlanePreparation(preparation), boardFeatureState: preparation.boardFeatureState });
      preparation.boardFeatureState?.verify(await readFile(project.pcbPath, "utf8"), preparation.dependencies.libraryResolver);
      return result;
    },
    expectedReport: () => planePreparationReportBody({ ...preparation, project }),
  });
}

import { serializePcbPlaneCompilationBundle } from "../harness/pcb-design-plane-bundle.js";
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
    verifySemantics: () => verifyFreshPlaneNetClassSemanticAuthority(preparation.netClassSemanticAuthority,
      { project, compilationBundle: preparation.bundle, kicad: preparation.kicadIdentity }),
    expectedReport: () => planePreparationReportBody({ ...preparation, project }),
  });
}

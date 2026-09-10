import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../core/canonical.js";
import { types } from "node:util";
import {
  initializeIsolatedKicadProject,
  nativeProjectFingerprint,
  type PreparedProject,
} from "../cli/pcb-agent.js";
import {
  createKicadHarnessTools,
  KICAD_HARNESS_TOOL_NAMES,
  type KicadHarnessTools,
} from "../harness/kicad-tools.js";
import { KicadMcpTerminationUncertainError, type KicadMcpBoundSessionAuthority, type KicadMcpSession } from "../integrations/kicad-mcp-session.js";
import { bindKicadStartupEvidence, captureKicadStartupFailure, withKicadStartupCleanup } from "../integrations/kicad-startup-diagnostic.js";
import { createToolboxPracticeAnalyzer } from "./toolbox-practices.js";
import type { ToolboxPreview } from "./toolbox-preview.js";
import type { KicadStackupReadResult } from "../integrations/kicad-stackup.js";
import type { ToolboxReferenceCoverage } from "./toolbox-reference-coverage.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type { ToolboxEndpointConnectivityResult } from "./toolbox-endpoint-connectivity.js";

/** Host capabilities only. This object is never parsed from an MCP request. */
export interface KicadToolboxSessionInput {
  readonly authority: KicadMcpBoundSessionAuthority;
  readonly prepared: PreparedProject;
  /** Exact board previously selected and opened by the owning host. */
  readonly pcbPath: string;
}

export interface ConnectedKicadToolbox {
  readonly tools: KicadHarnessTools;
  assertCurrent(): Promise<void>;
  captureSources(): Promise<string>;
  /** Source-bound host analysis; never accepts a model-selected path/profile. */
  analyzePractices?: () => Promise<unknown>;
  renderPreview?: ToolboxPreview;
  readStackup?: () => Promise<KicadStackupReadResult>;
  checkReferenceCoverage?: ToolboxReferenceCoverage;
  /** Saved-state V2 native copper reachability; not whole-board electrical acceptance. */
  checkEndpointConnectivity?: () => Promise<ToolboxEndpointConnectivityResult>;
  readonly planeAuthoringContext?: Readonly<{ projectBindingIdentity: CanonicalIdentity; sourceContractIdentity: CanonicalIdentity }>;
  /** Capture a verified saved-state guard now; publish only after owned teardown. */
  prepareCheckpoint?: () => Promise<() => Promise<void>>;
  recordRecoveryRequired?: (reason: string) => Promise<void>;
  close(): Promise<void>;
}

/**
 * Consume an existing manifest/socket-bound write authority without a provider.
 * Preparation, editor opening and runtime-profile approval belong to the host.
 * Fresh designs require their separate verified compilation/source capabilities
 * and are deliberately not admitted by this copied-project bootstrap.
 */
export async function openKicadToolboxSession(input: KicadToolboxSessionInput): Promise<ConnectedKicadToolbox> {
  const { authority, pcbPath } = input;
  const prepared = Object.freeze({ ...input.prepared });
  let session: KicadMcpSession | undefined;
  try {
    if (prepared.freshProject !== undefined) throw new Error("Toolbox copied-project bootstrap cannot authorize a fresh project.");
    const projectRoot = await realpath(prepared.isolatedProjectPath);
    const board = await realpath(pcbPath);
    const relative = path.relative(projectRoot, board);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || path.extname(board).toLowerCase() !== ".kicad_pcb" || !(await lstat(pcbPath)).isFile()) {
      throw new Error("Toolbox board must be an ordinary PCB file within its isolated project.");
    }
    const outputRoot = path.join(prepared.outputPath, ".evleda-mcp-output");
    session = await authority.connect({
      workspaceRoot: prepared.outputPath,
      projectRoot: prepared.isolatedProjectPath,
      outputRoot,
      mode: "write",
      isolatedWorkingCopy: { canonicalProjectRoot: prepared.sourceProjectPath },
      requiredTools: Object.freeze([...KICAD_HARNESS_TOOL_NAMES].sort()),
    });
    if (canonicalJson(session.identity.launch.sessionAuthorityIdentity) !== canonicalJson(authority.identity)) {
      throw new Error("Toolbox session differs from its host-owned write authority.");
    }
    await initializeIsolatedKicadProject(session, prepared, outputRoot);
    await session.assertActivePcb(board);
    const tools = createKicadHarnessTools(session, {
      capturePersistedMutationBaseline: () => nativeProjectFingerprint(projectRoot),
      verifyPersistedMutation: async (baseline) => baseline !== undefined && await nativeProjectFingerprint(projectRoot) !== baseline,
    });
    const ownedSession = session;
    const analyzePractices = await createToolboxPracticeAnalyzer({ pcbPath: board });
    let closing: Promise<void> | undefined;
    return Object.freeze({ tools, analyzePractices, assertCurrent: () => ownedSession.assertActivePcb(board),
      captureSources: () => nativeProjectFingerprint(projectRoot), close: () => closing ??= ownedSession.close() });
  } catch (error) {
    const primary = captureKicadStartupFailure(error, "session-connect");
    // Await owned teardown; an uncertain teardown must remain visible to the host.
    try { if (session !== undefined) await session.close(); else await authority.disposeUnused(); }
    catch (cleanupError) {
      const diagnostic = withKicadStartupCleanup(primary, "toolbox-session-cleanup", "unconfirmed", cleanupError);
      throw bindKicadStartupEvidence(new KicadMcpTerminationUncertainError("Copied toolbox startup failed and cleanup was not confirmed.", { cause: diagnostic }), diagnostic);
    }
    const diagnostic = withKicadStartupCleanup(primary, "toolbox-session-cleanup", "confirmed");
    if (!types.isProxy(error) && types.isNativeError(error)) throw bindKicadStartupEvidence(error, diagnostic);
    throw bindKicadStartupEvidence(new Error("Toolbox session startup failed.", { cause: diagnostic }), diagnostic);
  }
}

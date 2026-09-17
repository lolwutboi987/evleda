import { canonicalJson } from "../core/canonical.js";
import { types } from "node:util";
import { createFreshNativeCaptures, initializeIsolatedKicadProject, nativeProjectFingerprint } from "../cli/pcb-agent.js";
import { checkpointFreshProjectOpenNormalization, prepareFreshProject } from "../harness/fresh-project.js";
import { verifyFreshNetClassSemanticAuthority } from "../harness/fresh-clearance-evidence.js";
import { createKicadHarnessTools, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES } from "../harness/kicad-tools.js";
import type { FreshSchematicApprovedGeometryResolver } from "../harness/fresh-schematic-source-adapter.js";
import type { KicadNativePadObservationExpected } from "../integrations/kicad-native-pad-observation.js";
import type { KicadCliAdapter } from "../integrations/kicad-cli.js";
import { KicadMcpTerminationUncertainError, type KicadMcpBoundSessionAuthority, type KicadMcpSession } from "../integrations/kicad-mcp-session.js";
import { bindKicadStartupEvidence, captureKicadStartupFailure, withKicadStartupCleanup } from "../integrations/kicad-startup-diagnostic.js";
import { assertKicadToolboxFreshPreparation, type KicadToolboxFreshPreparation } from "./toolbox-fresh-preparation.js";
import { createToolboxPracticeAnalyzer } from "./toolbox-practices.js";
import type { ConnectedKicadToolbox } from "./toolbox-session.js";
import { createFreshToolboxCheckpointLifecycle } from "./toolbox-fresh-checkpoint.js";
import { saveInitialFreshProjectSettings } from "./toolbox-fresh-initial-save.js";
import path from "node:path";
import { assertPcbLibrarySourcesCurrent } from "../harness/pcb-library-source-binding.js";
import { writeToolboxFootprintPlacementDiagnostic } from "./toolbox-footprint-placement-diagnostics.js";
import { createToolboxSchematicFieldDiagnostics } from "./toolbox-schematic-field-diagnostics.js";

export interface KicadToolboxFreshSessionInput {
  readonly authority: KicadMcpBoundSessionAuthority;
  readonly preparation: KicadToolboxFreshPreparation;
  readonly createCliAdapter: typeof KicadCliAdapter.create;
}

/** Consume actual fresh preparation; plain JSON cannot supply its capabilities. */
export async function openKicadToolboxFreshSession(input: KicadToolboxFreshSessionInput): Promise<ConnectedKicadToolbox> {
  let session: KicadMcpSession | undefined;
  try {
    assertKicadToolboxFreshPreparation(input.preparation);
    const { preparation, authority } = input;
    const { bundle, bundleRef } = preparation;
    const original = preparation.project;
    const resolver = preparation.dependencies.libraryResolver;
    const assertSources = () => assertPcbLibrarySourcesCurrent(bundle.libraryBinding, resolver);
    assertSources();
    if (!("inspectFootprint" in resolver) || typeof resolver.inspectFootprint !== "function"
      || !("inspectSymbolTerminalGeometry" in resolver) || typeof resolver.inspectSymbolTerminalGeometry !== "function") {
      throw new Error("Fresh toolbox requires the approved stock physical-footprint and symbol-geometry resolver.");
    }
    const libraries = resolver as typeof resolver & FreshSchematicApprovedGeometryResolver & NonNullable<KicadNativePadObservationExpected["physicalFootprintResolver"]>;
    const physicalPins = Object.freeze(bundle.contract.components.map(component => {
      const footprint = libraries.inspectFootprint(component.footprintLibId);
      if (footprint === null || footprint.libraryId !== component.footprintLibId) throw new Error("Fresh toolbox approved physical footprint is unavailable.");
      return Object.freeze({ reference: component.reference, libraryId: component.footprintLibId, sourceIdentity: Object.freeze({ ...footprint.sourceIdentity }) });
    }));
    const outputRoot = path.join(original.outputPath, ".evleda-mcp-output");
    assertSources();
    session = await authority.connect({ workspaceRoot: original.outputPath, projectRoot: original.projectPath,
      outputRoot, mode: "write", freshProject: true, requiredTools: Object.freeze([...KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES].sort()) });
    if (canonicalJson(session.identity.launch.sessionAuthorityIdentity) !== canonicalJson(authority.identity)) throw new Error("Fresh toolbox session differs from its bound native authority.");
    assertSources();
    await initializeIsolatedKicadProject(session, { sourceProjectPath: original.projectPath, isolatedProjectPath: original.projectPath,
      outputPath: original.outputPath, reportPath: preparation.reportPath, freshProject: original }, outputRoot);
    await session.assertActivePcb(original.pcbPath);
    assertSources();
    if (preparation.mode !== "resumed") {
      await saveInitialFreshProjectSettings({ project: original, expectedPreparedSourceAuthority: preparation.preparedSourceAuthority, session });
      assertSources();
      await checkpointFreshProjectOpenNormalization({ outputDir: original.outputPath, name: original.name,
        expectedPreparedSourceAuthority: preparation.preparedSourceAuthority,
        expectedNetClassProjection: { netClasses: [...preparation.netClassSemanticAuthority.netClasses],
          contractNetAssignments: [...preparation.netClassSemanticAuthority.contractNetAssignments] } });
    }
    await verifyFreshNetClassSemanticAuthority(preparation.netClassSemanticAuthority,
      { project: original, compilationBundle: bundle, kicad: preparation.kicadIdentity });
    assertSources();
    const project = await prepareFreshProject({ outputDir: original.outputPath, name: original.name, resume: true,
      workflowKind: "generic", compilationBundle: bundle, compilationBundleRef: bundleRef });
    await session.assertActivePcb(project.pcbPath);
    assertSources();
    const captureSources = async () => {
      assertSources();
      const fingerprint = await nativeProjectFingerprint(project.projectPath);
      assertSources();
      return fingerprint;
    };
    const captures = createFreshNativeCaptures({ project, executablePath: preparation.kicadIdentity.path, createAdapter: input.createCliAdapter });
    if (captures.captureNativeNetlist === undefined || captures.captureNativeSchematicStrokeStyle === undefined) throw new Error("Fresh native capture capabilities are incomplete.");
    const schematicFieldDiagnostics = createToolboxSchematicFieldDiagnostics(outputRoot);
    const tools = createKicadHarnessTools(session, {
      freshProject: project, freshConnectivityContract: bundle.contract, freshCompilationBundle: bundle,
      freshLibraryResolver: resolver,
      freshSchematicGeometryResolver: libraries, freshPhysicalFootprintResolver: libraries, freshPhysicalFootprintSourcePins: physicalPins,
      captureFreshNativeNetlist: captures.captureNativeNetlist, captureFreshSchematicStrokeStyle: captures.captureNativeSchematicStrokeStyle,
      observeFreshFootprintPlacementDiagnostic: async diagnostic => { await writeToolboxFootprintPlacementDiagnostic(outputRoot, diagnostic); },
      observeFreshSchematicFieldDiagnostic: schematicFieldDiagnostics.observe,
      capturePersistedMutationBaseline: captureSources,
      verifyPersistedMutation: async baseline => baseline !== undefined && await captureSources() !== baseline,
    });
    const analyzePractices = await createToolboxPracticeAnalyzer({ pcbPath: project.pcbPath, profile: bundle.practiceProfileBinding.profile });
    const checkpoint = createFreshToolboxCheckpointLifecycle({ project, preparation, session });
    const owned = session; let closing: Promise<void> | undefined;
    return Object.freeze({ tools, analyzePractices, finalizeSchematicFieldFailure: schematicFieldDiagnostics.finalize, ...checkpoint,
      prepareCheckpoint: async () => {
        assertSources(); const publish = await checkpoint.prepareCheckpoint(); assertSources();
        return async () => { assertSources(); await publish(); assertSources(); };
      },
      assertCurrent: async () => { assertSources(); await owned.assertActivePcb(project.pcbPath); assertSources(); },
      captureSources, close: () => closing ??= owned.close() });
  } catch (error) {
    const primary = captureKicadStartupFailure(error, "session-connect");
    try { if (session !== undefined) await session.close(); else await input.authority.disposeUnused(); }
    catch (cleanupError) {
      const diagnostic = withKicadStartupCleanup(primary, "toolbox-session-cleanup", "unconfirmed", cleanupError);
      throw bindKicadStartupEvidence(new KicadMcpTerminationUncertainError("Fresh toolbox startup failed and cleanup was not confirmed.", { cause: diagnostic }), diagnostic);
    }
    const diagnostic = withKicadStartupCleanup(primary, "toolbox-session-cleanup", "confirmed");
    if (!types.isProxy(error) && types.isNativeError(error)) throw bindKicadStartupEvidence(error, diagnostic);
    throw bindKicadStartupEvidence(new Error("Toolbox session startup failed.", { cause: diagnostic }), diagnostic);
  }
}

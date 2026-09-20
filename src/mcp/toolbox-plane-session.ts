import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { types } from "node:util";
import { createFreshNativeCaptures, initializeIsolatedKicadProject, nativeProjectFingerprint } from "../cli/pcb-agent.js";
import { checkpointPlaneFreshProjectOpenNormalization, preparePlaneFreshProject } from "../harness/fresh-project.js";
import { verifyFreshPlaneNetClassSemanticAuthority } from "../harness/fresh-plane-netclasses.js";
import { createKicadHarnessTools, KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES } from "../harness/kicad-tools.js";
import type { FreshSchematicApprovedGeometryResolver } from "../harness/fresh-schematic-source-adapter.js";
import type { KicadNativePadObservationExpected } from "../integrations/kicad-native-pad-observation.js";
import type { KicadCliAdapter } from "../integrations/kicad-cli.js";
import { captureKicadNativeSourceHashes } from "../integrations/kicad-cli.js";
import type { KicadPlaneContactsReader } from "../integrations/kicad-plane-contacts.js";
import type { ReferenceCoverageCalculator } from "../integrations/kicad-reference-coverage.js";
import type { ContentIdentity } from "../domain/types.js";
import { assessFreshPlaneAcceptance } from "../harness/fresh-plane-acceptance.js";
import { assessFreshPlaneNativeChecks } from "../harness/fresh-plane-native-checks.js";
import { KicadMcpTerminationUncertainError, type KicadMcpBoundSessionAuthority, type KicadMcpSession } from "../integrations/kicad-mcp-session.js";
import { bindKicadStartupEvidence, captureKicadStartupFailure, withKicadStartupCleanup } from "../integrations/kicad-startup-diagnostic.js";
import { assertKicadToolboxPlanePreparation, type KicadToolboxPlanePreparation } from "./toolbox-plane-preparation.js";
import { createToolboxPracticeAnalyzer } from "./toolbox-practices.js";
import type { ConnectedKicadToolbox } from "./toolbox-session.js";
import { createPlaneToolboxCheckpointLifecycle } from "./toolbox-plane-checkpoint.js";
import { writeToolboxRouteDiagnostic } from "./toolbox-route-diagnostics.js";
import { writeToolboxSyncDiagnostic } from "./toolbox-sync-diagnostics.js";
import { writeToolboxFootprintPlacementDiagnostic } from "./toolbox-footprint-placement-diagnostics.js";
import { writeToolboxPlaneFailureDiagnostic } from "./toolbox-plane-failure-diagnostics.js";
import { createToolboxSchematicFieldDiagnostics } from "./toolbox-schematic-field-diagnostics.js";
import { captureToolboxEndpointConnectivity } from "./toolbox-endpoint-connectivity.js";
import { captureToolboxPlaneAcceptance } from "./toolbox-plane-acceptance.js";
import { saveInitialFreshProjectSettings } from "./toolbox-fresh-initial-save.js";
import { writeInitialSaveSourceMismatch } from "./toolbox-initial-save-diagnostics.js";
import type { KicadTransmissionLineCalculator } from "../integrations/kicad-transmission-line.js";
import { captureToolboxInterface } from "./toolbox-interface-report.js";
import { assertPcbLibrarySourcesCurrent } from "../harness/pcb-library-source-binding.js";
import { assertPcbExternalPowerBindingCurrent } from "../harness/pcb-external-power.js";
import { assertPcbDerivedPowerBindingCurrent, powerAnnotationBindingOf } from "../harness/pcb-derived-power.js";

export interface KicadToolboxPlaneSessionInput {
  readonly authority: KicadMcpBoundSessionAuthority;
  readonly preparation: KicadToolboxPlanePreparation;
  readonly createCliAdapter: typeof KicadCliAdapter.create;
  readonly createPlaneContactsReader?: (board:{readonly pcbPath:string;readonly expectedSourceIdentity:ContentIdentity})=>Promise<KicadPlaneContactsReader>;
  readonly referenceCoverage?: ReferenceCoverageCalculator;
}

/** V2 schematic/session composition. Plane copper authoring and acceptance are separate capabilities. */
export async function openKicadToolboxPlaneSession(input: KicadToolboxPlaneSessionInput): Promise<ConnectedKicadToolbox> {
  let session: KicadMcpSession | undefined;
  try {
    assertKicadToolboxPlanePreparation(input.preparation);
    const { preparation, authority } = input;
    const { bundle, bundleRef } = preparation, original = preparation.project, resolver = preparation.dependencies.libraryResolver;
    const assertSources = () => {
      assertPcbLibrarySourcesCurrent(bundle.libraryBinding, resolver);
      if (bundle.externalPowerBinding !== undefined) assertPcbExternalPowerBindingCurrent(bundle.externalPowerBinding, resolver);
      if (bundle.derivedPowerBinding !== undefined) assertPcbDerivedPowerBindingCurrent(bundle.derivedPowerBinding, bundle.libraryBinding, resolver);
    };
    assertSources();
    if (!("inspectFootprint" in resolver) || typeof resolver.inspectFootprint !== "function"
        || !("inspectSymbolTerminalGeometry" in resolver) || typeof resolver.inspectSymbolTerminalGeometry !== "function") {
      throw new Error("Plane toolbox requires approved physical footprint and symbol geometry inspection.");
    }
    const libraries = resolver as typeof resolver & FreshSchematicApprovedGeometryResolver & NonNullable<KicadNativePadObservationExpected["physicalFootprintResolver"]>;
    const physicalPins = Object.freeze([...bundle.contract.components, ...(bundle.contract.boardFeatures ?? [])].map(component => {
      const footprint = libraries.inspectFootprint(component.footprintLibId);
      if (footprint === null || footprint.libraryId !== component.footprintLibId) throw new Error("Approved plane-project footprint is unavailable.");
      return Object.freeze({ reference: component.reference, libraryId: component.footprintLibId, sourceIdentity: Object.freeze({ ...footprint.sourceIdentity }) });
    }));
    const outputRoot = path.join(original.outputPath, ".evleda-mcp-output");
    assertSources();
    session = await authority.connect({ workspaceRoot: original.outputPath, projectRoot: original.projectPath, outputRoot, mode: "write",
      freshProject: true, requiredTools: Object.freeze([...KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES].sort()) });
    if (canonicalJson(session.identity.launch.sessionAuthorityIdentity) !== canonicalJson(authority.identity)) throw new Error("Plane session differs from its exact native authority.");
    assertSources();
    await initializeIsolatedKicadProject(session, { sourceProjectPath: original.projectPath, isolatedProjectPath: original.projectPath,
      outputPath: original.outputPath, reportPath: preparation.reportPath, freshProject: original }, outputRoot);
    await session.assertActivePcb(original.pcbPath);
    assertSources();
    if (preparation.mode !== "resumed") {
      await saveInitialFreshProjectSettings({ project: original, expectedPreparedSourceAuthority: preparation.preparedSourceAuthority, session,
        onSourceMismatch: async diagnostic => { await writeInitialSaveSourceMismatch(outputRoot, diagnostic); } });
      assertSources();
      await checkpointPlaneFreshProjectOpenNormalization({ project: original,
        ...(preparation.placementSeed === undefined ? {} : { placementSeed: preparation.placementSeed }),
        expectedPreparedSourceAuthority: preparation.preparedSourceAuthority,
        expectedNetClassProjection: { netClasses: [...preparation.netClassSemanticAuthority.netClasses],
          contractNetAssignments: [...preparation.netClassSemanticAuthority.contractNetAssignments] } });
    }
    await verifyFreshPlaneNetClassSemanticAuthority(preparation.netClassSemanticAuthority, { project: original, compilationBundle: bundle, kicad: preparation.kicadIdentity,captureNativeNetlist:preparation.captureNativeNetlist,assertLibrarySources:assertSources, boardFeatureState: preparation.boardFeatureState });
    assertSources();
    const project = await preparePlaneFreshProject({ outputDir: original.outputPath, name: original.name, resume: true, compilationBundle: bundle, compilationBundleRef: bundleRef });
    await session.assertActivePcb(project.pcbPath);
    assertSources();
    const captureSources = async () => {
      assertSources();
      const fingerprint = await nativeProjectFingerprint(project.projectPath);
      assertSources();
      return fingerprint;
    };
    const captures = createFreshNativeCaptures({ project, executablePath: preparation.kicadIdentity.path, createAdapter: input.createCliAdapter });
    if (captures.captureNativeNetlist === undefined || captures.captureNativeSchematicStrokeStyle === undefined) throw new Error("Plane schematic native capture capabilities are incomplete.");
    const schematicFieldDiagnostics = createToolboxSchematicFieldDiagnostics(outputRoot);
    const tools = createKicadHarnessTools(session, { freshProject: project, freshConnectivityContract: bundle.contract, freshPlaneCompilationBundle: bundle,
      freshBoardFeatureState: preparation.boardFeatureState,
      freshLibraryResolver: resolver,
      assessFreshPlaneEvidence: async context => {
        assertSources();
        if(context.savedEvidence===null)return assessFreshPlaneAcceptance(context);
        await verifyFreshPlaneNetClassSemanticAuthority(preparation.netClassSemanticAuthority,
          {project,compilationBundle:bundle,kicad:preparation.kicadIdentity,captureNativeNetlist:captures.captureNativeNetlist,assertLibrarySources:assertSources,boardFeatureState:preparation.boardFeatureState});
        const expectedSourceHashes=await captureKicadNativeSourceHashes(project.projectPath);
        const reader=await input.createPlaneContactsReader?.({pcbPath:project.pcbPath,expectedSourceIdentity:contentIdentity(context.pcbSource)});
        const nativeContacts=await reader?.read();
        const cli=await input.createCliAdapter({workspaceRoot:project.outputPath,projectRoot:project.projectPath,outputRoot:project.outputPath,
          executablePath:preparation.kicadIdentity.path,expectedExecutableIdentity:{sha256:preparation.kicadIdentity.sha256,sizeBytes:preparation.kicadIdentity.sizeBytes}});
        const checks=await cli.runChecks({pcbPath:project.pcbPath,schematicPath:project.schematicPath,
          outputDirectory:path.join(project.outputPath,`plane-native-checks-${randomUUID()}`)});
        if(canonicalJson(expectedSourceHashes)!==canonicalJson(await captureKicadNativeSourceHashes(project.projectPath)))throw new Error("Complete native source inventory changed during plane acceptance checks.");
        const nativeChecks=assessFreshPlaneNativeChecks({compilationBundle:bundle,savedEvidence:context.savedEvidence,
          current:{projectBindingIdentity:context.projectBindingIdentity,sourceScopeIdentity:context.sourceScopeIdentity},
          sources:{projectRoot:project.projectPath,pcbPath:project.pcbPath,pcbSource:context.pcbSource,
            projectPath:path.join(project.projectPath,`${project.name}.kicad_pro`),projectSource:context.projectSettingsSource,
            rulesPath:project.rulesPath,rulesSource:context.rulesSource},expectedSourceHashes,expectedExecutable:preparation.kicadIdentity,
          nativeChecks:checks,...(nativeContacts===undefined?{}:{contacts:nativeContacts})});
        assertSources();
        return assessFreshPlaneAcceptance({...context,nativeChecks,...(nativeContacts===undefined?{}:{nativeContacts}),
          ...(input.referenceCoverage===undefined?{}:{referenceCoverage:input.referenceCoverage})});
      },
      freshSchematicGeometryResolver: libraries, freshPhysicalFootprintResolver: libraries, freshPhysicalFootprintSourcePins: physicalPins,
      captureFreshNativeNetlist: captures.captureNativeNetlist, captureFreshSchematicStrokeStyle: captures.captureNativeSchematicStrokeStyle,
      observeFreshRouteMutationDiagnostic: async diagnostic => { await writeToolboxRouteDiagnostic(outputRoot, diagnostic); },
      observeFreshSyncFailureDiagnostic: async diagnostic => { await writeToolboxSyncDiagnostic(outputRoot, diagnostic); },
      observeFreshFootprintPlacementDiagnostic: async diagnostic => { await writeToolboxFootprintPlacementDiagnostic(outputRoot, diagnostic); },
      observeFreshPlaneFailureDiagnostic: diagnostic => writeToolboxPlaneFailureDiagnostic(outputRoot, diagnostic),
      observeFreshSchematicFieldDiagnostic: schematicFieldDiagnostics.observe,
      capturePersistedMutationBaseline: captureSources,
      verifyPersistedMutation: async baseline => baseline !== undefined && await captureSources() !== baseline });
    const assertAnnotations = async () => {
      if (powerAnnotationBindingOf(bundle) === undefined) return;
      if (tools.assertExternalPowerAnnotationsCurrent === undefined) throw new Error("Annotated V2 sessions require their complete host source/graph guard.");
      await tools.assertExternalPowerAnnotationsCurrent();
    };
    await assertAnnotations();
    // The existing profile-free analyzer still checks the project's literal 45°
    // turn policy. Do not fabricate V1 width/via acceptance for a plane contract.
    const analyzePractices = await createToolboxPracticeAnalyzer({ pcbPath: project.pcbPath });
    assertSources();
    const checkpoint = createPlaneToolboxCheckpointLifecycle({ project, preparation, session });
    if (tools.assessPlaneConnectivity === undefined) throw new Error("Plane harness has no saved-native endpoint assessment capability.");
    const checkEndpointConnectivity = async () => captureToolboxEndpointConnectivity(outputRoot, await tools.assessPlaneConnectivity!());
    const checkPlaneAcceptance = async (calculator?: KicadTransmissionLineCalculator) => captureToolboxPlaneAcceptance(outputRoot, await tools.assessPlaneAcceptance!(calculator));
    const checkInterface = bundle.contract.interfaceRequirements === undefined ? undefined
      : async (interfaceId: string, calculator?: KicadTransmissionLineCalculator) => captureToolboxInterface(outputRoot, await tools.assessInterface!(interfaceId, calculator));
    const owned = session;
    let closing: Promise<void> | undefined;
    return Object.freeze({ tools, analyzePractices, finalizeSchematicFieldFailure: schematicFieldDiagnostics.finalize, checkEndpointConnectivity, checkPlaneAcceptance, ...checkpoint,
      prepareCheckpoint: async () => {
        assertSources(); await assertAnnotations();
        const publish = await checkpoint.prepareCheckpoint(); assertSources();
        return async () => { assertSources(); await publish(); assertSources(); };
      },
      ...(checkInterface === undefined ? {} : { checkInterface }),
      planeAuthoringContext: Object.freeze({ projectBindingIdentity: project.planeBinding.identity, sourceContractIdentity: bundle.contract.identity,
        ...(bundle.contract.boardFeatures === undefined ? {} : { boardFeatureCount: bundle.contract.boardFeatures.length }),
        ...(bundle.externalPowerBinding === undefined ? {} : { externalPowerBinding: bundle.externalPowerBinding }),
        ...(bundle.derivedPowerBinding === undefined ? {} : { derivedPowerBinding: bundle.derivedPowerBinding }) }),
      assertCurrent: async () => { assertSources(); await owned.assertActivePcb(project.pcbPath); await assertAnnotations(); assertSources(); }, captureSources,
      close: () => closing ??= owned.close() });
  } catch (error) {
    const primary = captureKicadStartupFailure(error, "session-connect");
    try { if (session !== undefined) await session.close(); else await input.authority.disposeUnused(); }
    catch (cleanupError) {
      const diagnostic = withKicadStartupCleanup(primary, "toolbox-session-cleanup", "unconfirmed", cleanupError);
      throw bindKicadStartupEvidence(new KicadMcpTerminationUncertainError("Plane startup failed and owned cleanup was not confirmed.", { cause: diagnostic }), diagnostic);
    }
    const diagnostic = withKicadStartupCleanup(primary, "toolbox-session-cleanup", "confirmed");
    if (!types.isProxy(error) && types.isNativeError(error)) throw bindKicadStartupEvidence(error, diagnostic);
    throw bindKicadStartupEvidence(new Error("Toolbox session startup failed.", { cause: diagnostic }), diagnostic);
  }
}

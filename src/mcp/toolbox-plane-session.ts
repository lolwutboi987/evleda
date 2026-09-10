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
import { captureToolboxEndpointConnectivity } from "./toolbox-endpoint-connectivity.js";
import { captureToolboxPlaneAcceptance } from "./toolbox-plane-acceptance.js";
import { saveInitialFreshProjectSettings } from "./toolbox-fresh-initial-save.js";

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
    if (!("inspectFootprint" in resolver) || typeof resolver.inspectFootprint !== "function"
        || !("inspectSymbolTerminalGeometry" in resolver) || typeof resolver.inspectSymbolTerminalGeometry !== "function") {
      throw new Error("Plane toolbox requires approved physical footprint and symbol geometry inspection.");
    }
    const libraries = resolver as typeof resolver & FreshSchematicApprovedGeometryResolver & NonNullable<KicadNativePadObservationExpected["physicalFootprintResolver"]>;
    const physicalPins = Object.freeze(bundle.contract.components.map(component => {
      const footprint = libraries.inspectFootprint(component.footprintLibId);
      if (footprint === null || footprint.libraryId !== component.footprintLibId) throw new Error("Approved plane-project footprint is unavailable.");
      return Object.freeze({ reference: component.reference, libraryId: component.footprintLibId, sourceIdentity: Object.freeze({ ...footprint.sourceIdentity }) });
    }));
    const outputRoot = path.join(original.outputPath, ".evleda-mcp-output");
    session = await authority.connect({ workspaceRoot: original.outputPath, projectRoot: original.projectPath, outputRoot, mode: "write",
      freshProject: true, requiredTools: Object.freeze([...KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES].sort()) });
    if (canonicalJson(session.identity.launch.sessionAuthorityIdentity) !== canonicalJson(authority.identity)) throw new Error("Plane session differs from its exact native authority.");
    await initializeIsolatedKicadProject(session, { sourceProjectPath: original.projectPath, isolatedProjectPath: original.projectPath,
      outputPath: original.outputPath, reportPath: preparation.reportPath, freshProject: original }, outputRoot);
    await session.assertActivePcb(original.pcbPath);
    if (preparation.mode !== "resumed") {
      await saveInitialFreshProjectSettings({ project: original, expectedPreparedSourceAuthority: preparation.preparedSourceAuthority, session });
      await checkpointPlaneFreshProjectOpenNormalization({ project: original,
        expectedPreparedSourceAuthority: preparation.preparedSourceAuthority,
        expectedNetClassProjection: { netClasses: [...preparation.netClassSemanticAuthority.netClasses],
          contractNetAssignments: [...preparation.netClassSemanticAuthority.contractNetAssignments] } });
    }
    await verifyFreshPlaneNetClassSemanticAuthority(preparation.netClassSemanticAuthority, { project: original, compilationBundle: bundle, kicad: preparation.kicadIdentity });
    const project = await preparePlaneFreshProject({ outputDir: original.outputPath, name: original.name, resume: true, compilationBundle: bundle, compilationBundleRef: bundleRef });
    await session.assertActivePcb(project.pcbPath);
    const captures = createFreshNativeCaptures({ project, executablePath: preparation.kicadIdentity.path, createAdapter: input.createCliAdapter });
    if (captures.captureNativeNetlist === undefined || captures.captureNativeSchematicStrokeStyle === undefined) throw new Error("Plane schematic native capture capabilities are incomplete.");
    const tools = createKicadHarnessTools(session, { freshProject: project, freshConnectivityContract: bundle.contract, freshPlaneCompilationBundle: bundle,
      assessFreshPlaneEvidence: async context => {
        if(context.savedEvidence===null)return assessFreshPlaneAcceptance(context);
        await verifyFreshPlaneNetClassSemanticAuthority(preparation.netClassSemanticAuthority,
          {project,compilationBundle:bundle,kicad:preparation.kicadIdentity});
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
        return assessFreshPlaneAcceptance({...context,nativeChecks,...(nativeContacts===undefined?{}:{nativeContacts}),
          ...(input.referenceCoverage===undefined?{}:{referenceCoverage:input.referenceCoverage})});
      },
      freshSchematicGeometryResolver: libraries, freshPhysicalFootprintResolver: libraries, freshPhysicalFootprintSourcePins: physicalPins,
      captureFreshNativeNetlist: captures.captureNativeNetlist, captureFreshSchematicStrokeStyle: captures.captureNativeSchematicStrokeStyle,
      observeFreshRouteMutationDiagnostic: async diagnostic => { await writeToolboxRouteDiagnostic(outputRoot, diagnostic); },
      capturePersistedMutationBaseline: () => nativeProjectFingerprint(project.projectPath),
      verifyPersistedMutation: async baseline => baseline !== undefined && await nativeProjectFingerprint(project.projectPath) !== baseline });
    // The existing profile-free analyzer still checks the project's literal 45°
    // turn policy. Do not fabricate V1 width/via acceptance for a plane contract.
    const analyzePractices = await createToolboxPracticeAnalyzer({ pcbPath: project.pcbPath });
    const checkpoint = createPlaneToolboxCheckpointLifecycle({ project, preparation, session });
    if (tools.assessPlaneConnectivity === undefined) throw new Error("Plane harness has no saved-native endpoint assessment capability.");
    const checkEndpointConnectivity = async () => captureToolboxEndpointConnectivity(outputRoot, await tools.assessPlaneConnectivity!());
    const checkPlaneAcceptance = async () => captureToolboxPlaneAcceptance(outputRoot, await tools.assessPlaneAcceptance!());
    const owned = session;
    let closing: Promise<void> | undefined;
    return Object.freeze({ tools, analyzePractices, checkEndpointConnectivity, checkPlaneAcceptance, ...checkpoint,
      planeAuthoringContext: Object.freeze({ projectBindingIdentity: project.planeBinding.identity, sourceContractIdentity: bundle.contract.identity }),
      assertCurrent: () => owned.assertActivePcb(project.pcbPath), captureSources: () => nativeProjectFingerprint(project.projectPath),
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

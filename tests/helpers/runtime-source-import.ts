import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ContentIdentity } from "../../src/domain/types.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { FRESH_RUNTIME_IMPORT_SOURCE_KEYS, captureFreshRuntimeImportFile } from "../../src/harness/fresh-project.js";
import { createPlaneToolboxCheckpointLifecycle } from "../../src/mcp/toolbox-plane-checkpoint.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { assertFreshPlaneSchematicSeedProfile } from "../../src/harness/fresh-plane-schematic-seed.js";
import type { KicadMcpRuntimeBridge, KicadMcpSession } from "../../src/integrations/kicad-mcp-session.js";
import type { RuntimeSourceImportDependencies, RuntimeSourceImportRequest } from "../../src/mcp/toolbox-runtime-source-import.js";
import { unwiredPlaneSeedFixture } from "./unwired-plane-seed.js";

/** No executable/GUI/native calls: real file custody, store, issuer and close
 * lifecycle surround explicit synthetic profile/runtime/native-port seams. */
export async function runtimeSourceImportFixture() {
  const f = await unwiredPlaneSeedFixture(), source = await f.closedSource();
  const closedLease = await f.store.acquireLease(source.projectId);
  const sourceLifecycle = createPlaneToolboxCheckpointLifecycle({ project: source.preparation.project, preparation: source.preparation,
    session: { readActivePcbSource: async () => readFile(source.preparation.project.pcbPath, "utf8") } as unknown as KicadMcpSession });
  await (await sourceLifecycle.prepareCheckpoint())(); await closedLease.release();
  const pin = async (file: string, value: unknown) => { const bytes = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); return { path: file, contentIdentity: contentIdentity(bytes) }; };
  const published = (p: { path: string; contentIdentity: ReturnType<typeof contentIdentity> }) => ({ path: p.path, sha256: p.contentIdentity.digest, sizeBytes: p.contentIdentity.size });
  const relativePaths = ["environment/Lib/site-packages/kicad_mcp/tools/schematic.py", "environment/Lib/site-packages/kicad_mcp/models/visual_qa.py", "environment/pyvenv.cfg"];
  type FilePin = { relativePath: string; contentIdentity: ContentIdentity };
  const runtimeData: { root: string; files: { path: string; sizeBytes: number; sha256: string; mode: number }[]; manifest: any;
    manifestPin: { path: string; contentIdentity: ContentIdentity }; python: FilePin; entrypoint: FilePin; terminator: FilePin }[] = [];
  for (const [index, label] of ["old-runtime", "new-runtime"].entries()) {
    const root = path.join(f.root, label), files: { path: string; sizeBytes: number; sha256: string; mode: number }[] = [];
    for (const relative of [...relativePaths, "python/python.exe", "environment/entry.py", "bin/terminator.exe"]) {
      const value = relative === "environment/pyvenv.cfg" ? `home = ${path.join(root, "python")}\nunchanged = yes\n`
        : relative.endsWith("schematic.py") || relative.endsWith("visual_qa.py") ? `version = ${index}\n` : "unchanged binary fixture\n";
      const p = await pin(path.join(root, relative), value); files.push({ path: relative, sizeBytes: p.contentIdentity.size, sha256: p.contentIdentity.digest, mode: 0o666 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path, "en-US"));
    const directories = ["bin", "environment", "environment/Lib", "environment/Lib/site-packages", "environment/Lib/site-packages/kicad_mcp",
      "environment/Lib/site-packages/kicad_mcp/models", "environment/Lib/site-packages/kicad_mcp/tools", "python"].sort((a, b) => a.localeCompare(b, "en-US")).map(path => ({ path, mode: 0o777 }));
    const filePin = (relativePath: string) => { const file = files.find(file => file.path === relativePath)!; return { relativePath, contentIdentity: { algorithm: "sha256" as const, digest: file.sha256, size: file.sizeBytes } }; };
    const payload = { schemaVersion: "evleda.kicad-mcp-runtime-manifest.v2", classification: "pinned-local-kicad-mcp-runtime", platform: "win32-x64",
      distribution: { name: "kicad-mcp-pro", version: "3.33.3" }, protocol: { serverName: "kicad-mcp-pro", serverVersion: "1.29.1", transport: "stdio", modes: ["readonly", "write"] },
      python: { version: "3.13.12", ...filePin("python/python.exe") }, entrypoint: { ...filePin("environment/entry.py"), callable: "kicad_mcp.server:_run_server_from_options" },
      packageMetadata: { relativePath: "metadata", consoleEntryPointRelativePath: "entrypoints", packages: [] }, pthPolicy: { paths: [], siteCustomization: "forbidden", bytecode: "forbidden" },
      nativeDependencyPolicy: { systemDlls: [], images: [] }, fileCount: files.length, directoryCount: directories.length, totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), directories, files,
      treeIdentity: canonicalIdentity({ directories, files }, "evleda.kicad-mcp-inspection-runtime-tree.v1") };
    const manifest = { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) }, manifestPin = await pin(path.join(f.root, `${label}-manifest.json`), manifest);
    runtimeData.push({ root, files, manifest, manifestPin, python: filePin("python/python.exe"), entrypoint: filePin("environment/entry.py"), terminator: filePin("bin/terminator.exe") });
  }
  const profiles = [];
  for (const runtime of runtimeData) {
    const expectedClosure = { fileCount: runtime.manifest.fileCount, totalBytes: runtime.manifest.totalBytes, manifestIdentity: runtime.manifest.identity,
      treeIdentity: runtime.manifest.treeIdentity, python: { relativePath: runtime.python.relativePath, identity: runtime.python.contentIdentity },
      entrypoint: { relativePath: runtime.entrypoint.relativePath, identity: runtime.entrypoint.contentIdentity }, protocol: { distribution: "kicad-mcp-pro", distributionVersion: "3.33.3", ...runtime.manifest.protocol } };
    const data = { libraries: { stock: "identical-test-sources" }, deepRules: { same: true }, policy: { edit: true }, kicadToolchain: {
      binRoot: f.root, kicadCli: { path: f.expectedKicadCli.path, identity: f.expectedKicadCli.contentIdentity, operationalVersion: "10.0.3", operationalCommit: f.expectedKicadCli.operationalCommit } },
      kicadMcpRuntime: { runtimeBundle: { root: runtime.root, manifest: { path: runtime.manifestPin.path, identity: runtime.manifestPin.contentIdentity }, expectedClosure },
        runtimePolicy: { pythonLaunch: { flags: ["-I", "-s", "-E", "-B"], argumentCount: 5, bytecodeWrites: "disabled",
          argumentsSha256: createHash("sha256").update("evleda.kicad-mcp-arguments.v1\0").update(JSON.stringify(["-I", "-s", "-E", "-B", path.join(runtime.root, runtime.entrypoint.relativePath)])).digest("hex") } },
        processTreeSupervision: { terminator: { path: path.join(runtime.root, "bin/terminator.exe"), identity: runtime.terminator.contentIdentity } } } };
    profiles.push({ data, pin: await pin(path.join(f.root, `${path.basename(runtime.root)}-profile.json`), data) });
  }
  const [oldProfile, newProfile] = profiles, [oldRuntime, newRuntime] = runtimeData;
  const runtimeRecord = (r: typeof oldRuntime) => ({ root: r!.root, manifest: published(r!.manifestPin), manifestIdentity: r!.manifest.identity,
    treeIdentity: r!.manifest.treeIdentity, fileCount: r!.manifest.fileCount, totalBytes: r!.manifest.totalBytes });
  const oraclePin = await pin(path.join(f.root, "evidence/oracle.json"), { schemaVersion: "evleda.native-schematic-cardinal-oracle.v1",
    nativeExecution: true, sourcesUnchanged: true, version: "10.0.3", cliIdentity: f.expectedKicadCli.contentIdentity,
    inputs: [{}, {}, {}], cases: Array.from({ length: 12 }, () => ({})), observations: Array.from({ length: 36 }, () => ({})) });
  const summary = (passed: boolean) => ({ publicPinPositions: passed, exactPinAliases: passed, publicConnectivityGraph: passed, visualBounds: passed,
    ...Object.fromEntries(["pinMismatches", "aliasMismatches", "graphMismatches", "visualPinMismatches", "visualStrokeMismatches", "visualBoxFailures"].map(key => [key, passed ? 0 : 1])) });
  const observations = [];
  for (const [i, runtime] of runtimeData.entries()) observations.push(await pin(path.join(f.root, `evidence/observations-${i}.json`), {
    schemaVersion: "evleda.schematic-cardinal-runtime-observation.v1", runtimeRoot: runtime.root, oracle: published(oraclePin), summary: summary(i === 1), fixtureUnchanged: true,
    pythonFlags: { isolated: true, noUserSite: true, ignoreEnvironment: true, noBytecode: true, utf8: true } }));
  const recapture = await pin(path.join(f.root, "evidence/recapture.json"), { observationsEqual: true, casesEqual: true, sourceBytesEqual: true, sourcesUnchanged: true, logicalPins: 36,
    pythonFlags: { isolated: 1, ignoreEnvironment: 1, noUserSite: 1, dontWriteBytecode: 1, utf8Mode: 1 } });
  const echo = { sourceProfile: published(oldProfile!.pin), targetProfile: published(newProfile!.pin), sourceRuntime: runtimeRecord(oldRuntime), targetRuntime: runtimeRecord(newRuntime),
    oracle: { ...published(oraclePin), cliIdentity: f.expectedKicadCli.contentIdentity } };
  const checks = { passed: true, publicPinPositions: true, exactPinAliases: true, publicConnectivityGraph: true, visualBounds: true, oldNegativeControl: true };
  const report = { schemaVersion: "evleda.schematic-cardinal-runtime-qualification-report.v1", ...echo, checks, sourceSummary: summary(false), targetSummary: summary(true),
    sourceObservations: published(observations[0]!), targetObservations: published(observations[1]!), nativeStrictRecapture: published(recapture),
    closureChecks: { source: published(await pin(path.join(f.root, "evidence/old-closure.json"), { verified: true })), target: published(await pin(path.join(f.root, "evidence/new-closure.json"), { verified: true })) } };
  const reportPin = await pin(path.join(f.root, "evidence/report.json"), report);
  const proof = { schemaVersion: "evleda.schematic-cardinal-runtime-qualification.v1", ...echo,
    allowedRuntimeChanges: relativePaths.map(relative => { const before = oldRuntime!.files.find(file => file.path === relative)!, after = newRuntime!.files.find(file => file.path === relative)!;
      return { path: relative, before: { sha256: before.sha256, sizeBytes: before.sizeBytes }, after: { sha256: after.sha256, sizeBytes: after.sizeBytes }, reason: "Synthetic reviewed correction fixture" }; }),
    qualification: { report: published(reportPin), ...checks }, sourceRuntimeUnchanged: true,
    profilePolicyComparison: { allowedPaths: ["kicadMcpRuntime.runtimeBundle", "kicadMcpRuntime.processTreeSupervision.terminator.path", "kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentsSha256"], othersEqual: true }, noNativeAcceptanceTransferred: true };
  const proofPin = await pin(path.join(f.root, "evidence/receipt.json"), proof);
  const closeRequest = await pin(path.join(f.root, "close/request.json"), { id: "close", operation: "call", name: "evleda_close_project", arguments: { projectId: source.projectId } });
  const sessionPin = await pin(path.join(f.root, "close/session.json"), { startedAt: new Date().toISOString(), serverArgs: ["--profile", oldProfile!.pin.path,
    "--profile-sha256", oldProfile!.pin.contentIdentity.digest, "--profile-bytes", String(oldProfile!.pin.contentIdentity.size), "--workspace-root", f.workspaceRoot, "--edit"] });
  const responsePin = await pin(path.join(f.root, "close/response.json"), { recordedAt: new Date().toISOString(), request: { path: closeRequest.path, identity: closeRequest.contentIdentity }, disposition: "response", isError: false,
    result: { structuredContent: { status: "closed", projectId: source.projectId, designAcceptance: "not_implied" } } });
  const p = source.preparation.project;
  const sourcePaths = { marker: p.markerPath, checkpoint: p.checkpointPath, bundle: source.preparation.bundlePath, report: source.preparation.reportPath,
    sch: p.schematicPath, pcb: p.pcbPath, pro: path.join(p.projectPath, "seeded.kicad_pro"), dru: p.rulesPath, symLibTable: path.join(p.projectPath, "sym-lib-table"), fpLibTable: path.join(p.projectPath, "fp-lib-table") };
  const sourcePins = Object.fromEntries(await Promise.all(FRESH_RUNTIME_IMPORT_SOURCE_KEYS.map(async key => [key, contentIdentity(await readFile(sourcePaths[key]))]))) as RuntimeSourceImportRequest["sourcePins"];
  const request: RuntimeSourceImportRequest = { schemaVersion: "evleda.plane-runtime-source-import-request.v1", workspaceRoot: f.workspaceRoot,
    sourceProjectId: source.projectId, targetProjectId: randomUUID(), sourceProfile: oldProfile!.pin, targetProfile: newProfile!.pin,
    sourcePins, normalClose: { session: sessionPin, response: responsePin }, runtimeQualification: proofPin };
  const calls: string[] = []; let onOpen: ((target: Awaited<ReturnType<typeof f.prepare>>) => Promise<void>) | undefined, failRecovery = false;
  const dependencies: RuntimeSourceImportDependencies = {
    readNativeProfile: async input => { calls.push("profile"); return JSON.parse(await readFile(input.path, "utf8")); },
    loadDesignProfile: async () => ({ dependencies: f.dependencies, protectedRoots: [f.stock], profileIdentity: f.profile.contentIdentity,
      deepRuleSelectionOptions: f.compile().selectionPolicy, libraryEnvironment: { KICAD10_SYMBOL_DIR: f.symbolRoot, KICAD10_FOOTPRINT_DIR: path.join(f.stock, "footprints") } }),
    runtimeAuthority: async profile => { const runtime = runtimeData.find(runtime => runtime.root === profile.kicadMcpRuntime.runtimeBundle.root)!;
      const assertCurrent = async () => { calls.push("closure"); for (const file of runtime.files) await captureFreshRuntimeImportFile({ path: path.join(runtime.root, file.path),
        contentIdentity: { algorithm: "sha256", digest: file.sha256, size: file.sizeBytes } }, 1024 * 1024);
        if ((await readdir(runtime.root)).some(name => !["environment", "python", "bin"].includes(name))) throw new Error("runtime extra file"); };
      await assertCurrent(); return { assertCurrent } as KicadMcpRuntimeBridge; },
    openBinding: async input => {
      calls.push("open-new"); if (input.resume !== false) throw new Error("Must use new issuer"); assertFreshPlaneSchematicSeedProfile(input.fresh.schematicSeed!, request.targetProfile);
      const target = await f.prepare(input.outputDir, input.fresh.draft as any, { originalPrompt: input.fresh.originalPrompt!, expectedBundleIdentity: input.fresh.expectedBundleIdentity!, schematicSeed: input.fresh.schematicSeed! });
      const lifecycle = createPlaneToolboxCheckpointLifecycle({ project: target.project, preparation: target,
        session: { readActivePcbSource: async () => readFile(target.project.pcbPath, "utf8") } as unknown as KicadMcpSession });
      await onOpen?.(target);
      return { access: "edit", compoundContractIdentity: createFreshConnectivityContract(target.bundle.contract).identity, designContext: () => ({ family: "plane-v2" }),
        cad: { tools: { tools: [], execute: async () => { throw new Error("unexpected tool"); } }, assertCurrent: async () => {}, captureSources: async () => "unchanged", ...lifecycle,
          recordRecoveryRequired: async (reason: string) => { if (failRecovery) throw new Error("recovery marker failure"); await lifecycle.recordRecoveryRequired(reason); },
          close: async () => { calls.push("normal-close"); } } as unknown as ConnectedKicadToolbox };
    },
  };
  return { ...f, compilerDependencies: f.dependencies, source, sourcePaths, request, dependencies, proof, report, profiles, runtimeData, calls, pin, published,
    setOnOpen: (callback: typeof onOpen) => { onOpen = callback; }, failRecovery: () => { failRecovery = true; },
    recloseSource: async () => {
      const lease = await f.store.acquireLease(source.projectId); await (await sourceLifecycle.prepareCheckpoint())(); await lease.release();
      for (const key of FRESH_RUNTIME_IMPORT_SOURCE_KEYS) request.sourcePins[key] = contentIdentity(await readFile(sourcePaths[key]));
      const response = JSON.parse(await readFile(responsePin.path, "utf8")); response.recordedAt = new Date().toISOString();
      request.normalClose.response = await pin(responsePin.path, response);
    } };
}

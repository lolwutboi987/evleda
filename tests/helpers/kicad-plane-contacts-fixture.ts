/** Synthetic offline process-port fixture. Its branded receipt is NOT native KiCad evidence. */
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import type { BoundedProcessRunner } from "../../src/integrations/bounded-process.js";
import {
  createKicadPlaneContactsReader,
  type KicadPlaneContactsNativeReport,
  type KicadPlaneContactsOptions,
} from "../../src/integrations/kicad-plane-contacts.js";

const prefix = "evleda-plane-contacts-test-";
const ownedRoots = new Set<string>();
const absentPaths = [
  "pyvenv.cfg", "bin/pyvenv.cfg", "bin/python._pth", "bin/python311._pth", "bin/python311.zip",
  "bin/python.exe.local", "bin/python311.dll.local", "bin/Lib/sitecustomize.py", "bin/Lib/usercustomize.py",
  "bin/Lib/site-packages/sitecustomize.py", "bin/Lib/site-packages/usercustomize.py",
  "bin/Lib/site-packages/pcbnew", "bin/Lib/site-packages/_pcbnew", "bin/Lib/site-packages/pcbnew.pyc",
  "bin/Lib/site-packages/pcbnew.pyd", "bin/Lib/site-packages/_pcbnew.py",
];
const nativeIdentity = (bytes: string) => {
  const identity = contentIdentity(bytes);
  return { sha256: identity.digest, sizeBytes: identity.size };
};

/** Delete only a canonical, ordinary temporary directory created by this fixture in this process. */
export async function cleanupPlaneContactsFixture(root: string): Promise<void> {
  const absolute = path.resolve(root), temporary = await realpath(tmpdir());
  if (!ownedRoots.has(absolute) || path.dirname(absolute) !== temporary
      || !path.basename(absolute).startsWith(prefix) || absolute !== await realpath(absolute)) {
    throw new Error("Refusing to remove an unowned plane-contacts fixture directory.");
  }
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Fixture cleanup requires an ordinary owned directory.");
  await rm(absolute, { recursive: true, force: true });
  ownedRoots.delete(absolute);
}

export async function createPlaneContactsFixture(input: {
  pcbSource?: string;
  report?: Partial<KicadPlaneContactsNativeReport>;
} = {}) {
  const root = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), prefix)));
  ownedRoots.add(root);
  try {
    const runtimeRoot = path.join(root, "runtime"), outputRoot = path.join(root, "output");
    const pcbPath = path.join(root, "board.kicad_pcb"), helperPath = path.join(root, "helper.py");
    const manifestPath = path.join(root, "runtime-manifest.json");
    const pcbSource = input.pcbSource ?? '(kicad_pcb (version 20260206) (generator "offline-test") (layers (0 "F.Cu" signal) (2 "B.Cu" signal)))\n';
    const helperSource = "# Offline fixture only; never execute this helper.\n";
    const directories = ["bin", "bin/DLLs", "bin/Lib", "bin/Lib/site-packages"];
    for (const relative of directories) await mkdir(path.join(runtimeRoot, relative), { recursive: true });
    await mkdir(outputRoot);
    const contents: Record<string, string> = {
      "bin/python.exe": "synthetic python executable fixture\n",
      "bin/python311.dll": "synthetic python runtime fixture\n",
      "bin/Lib/os.py": "# synthetic os module fixture\n",
      "bin/Lib/site-packages/pcbnew.py": "# synthetic pcbnew module fixture\n",
      "bin/Lib/site-packages/_pcbnew.pyd": "synthetic pcbnew extension fixture\n",
    };
    const files = [];
    for (const [relative, bytes] of Object.entries(contents)) {
      await writeFile(path.join(runtimeRoot, relative), bytes);
      files.push({ path: relative, ...nativeIdentity(bytes), originalPath: path.join(root, "unexecuted-original", relative) });
    }
    await writeFile(pcbPath, pcbSource);
    await writeFile(helperPath, helperSource);
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const system32 = path.win32.join(windowsRoot, "System32");
    const systemDependencies = [path.win32.join(system32, "kernel32.dll")];
    const helper = { path: helperPath, ...nativeIdentity(helperSource) };
    const pythonVersion = "3.11.5 (main, Jan 23 2026, 07:39:48) [MSC v.1944 64 bit (AMD64)]";
    const provenancePin = { path: path.join(root, "offline-provenance.json"), sha256: "1".repeat(64) };
    const manifest = {
      schemaVersion: "evleda.native-plane-contacts-isolated-runtime.v1",
      classification: "qualified-isolated-runtime-candidate-not-production-authorization",
      runtimeRoot, expectedBuildVersion: "10.0.3", expectedCommitHash: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
      executableRelativePath: "bin/python.exe", pythonArgs: ["-I", "-s", "-E", "-B", "-S"],
      environmentOverrides: { PATH: system32 }, helper,
      fileCount: files.length, directoryCount: directories.length,
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), directories, files,
      closedTreePolicy: { allowExtraFiles: false, allowReparsePoints: false, allowExtraDirectories: false,
        verifyBeforeAndAfterExecution: true, allowBytecode: false },
      requiredAbsentRelativePaths: absentPaths, windowsSystemNativeDependencyPaths: systemDependencies,
      provenance: { isolatedObservation: provenancePin, sourceCopyPolicy: "Synthetic offline fixture; no installation was copied or executed.",
        sourceObservationManifest: provenancePin,
        privateExecutionObservation: { ...provenancePin, runtimePinsUnchanged: true, sourceUnchanged: true, privateFilesCreated: 0 } },
      limits: ["Synthetic offline test data, never native evidence or authorization."],
      workingDirectoryPolicy: "private-empty-directory-outside-runtime", expectedPythonVersion: pythonVersion,
      privateEnvironmentPolicy: { privatePathVariables: ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "KICAD_CONFIG_HOME", "TEMP", "TMP"],
        privateHomeDerivedVariables: ["HOMEDRIVE", "HOMEPATH"], noOtherVariables: true, inheritAmbientEnvironment: false,
        trustedSystemVariables: ["SystemRoot", "WINDIR", "PATH"] },
    };
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(manifestPath, manifestBytes);
    const runtimeFile = (relative: string) => ({ path: path.join(runtimeRoot, relative), ...nativeIdentity(contents[relative]!) });
    const loadedModule = (relative: string) => ({ ...runtimeFile(relative), origin: path.join(runtimeRoot, relative), bytecodeCachePath: null, bytecodeCache: null });
    const bin = path.join(runtimeRoot, "bin"), lib = path.join(bin, "Lib"), dlls = path.join(bin, "DLLs"), site = path.join(lib, "site-packages");
    const report: KicadPlaneContactsNativeReport = {
      schemaVersion: "evleda.native-plane-contacts.v1", ok: true,
      source: { basename: path.basename(pcbPath), before: nativeIdentity(pcbSource), after: nativeIdentity(pcbSource) },
      runtime: { buildVersion: "10.0.3", commitHash: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", pythonVersion,
        pythonExecutable: runtimeFile("bin/python.exe"), pcbnewModule: runtimeFile("bin/Lib/site-packages/pcbnew.py"),
        nativeExtension: runtimeFile("bin/Lib/site-packages/_pcbnew.pyd"), helper,
        importPaths: [dlls, lib, site], siteInitializationDisabled: true,
        initialImportPaths: [path.join(bin, "python311.zip"), dlls, lib, bin], initialPrefix: bin, initialBasePrefix: bin,
        loadedPythonModules: { os: loadedModule("bin/Lib/os.py"), pcbnew: loadedModule("bin/Lib/site-packages/pcbnew.py"),
          _pcbnew: loadedModule("bin/Lib/site-packages/_pcbnew.pyd") },
        bundledNativeDependencies: [runtimeFile("bin/python.exe"), runtimeFile("bin/python311.dll"), runtimeFile("bin/Lib/site-packages/_pcbnew.pyd")],
        windowsSystemNativeDependencyPaths: [...systemDependencies] },
      connectivity: { built: true, api: "direct-zone-neighbors", zoneScope: "aggregate-native-subpolygons" },
      inventory: { zoneCount: input.report?.zones?.length ?? 0, padCount: input.report?.allPads?.length ?? 0,
        footprintCount: input.report?.allFootprints?.length ?? 0, trackCount: input.report?.allTracks?.length ?? 0 },
      capabilities: { perLayerPadstackZoneConnectionAvailable: false, effectivePadZoneConnectionAvailable: false, physicalThermalSpokeCountAvailable: false },
      zones: [], allPads: [], allFootprints: [], allTracks: [], ...input.report,
    };
    const runner = vi.fn<BoundedProcessRunner>(async processOptions => ({
      command: processOptions.command, args: [...processOptions.args], cwd: processOptions.cwd,
      exitCode: 0, stdout: JSON.stringify(report), stderr: "", durationMs: 1, startedAt: "2026-09-10T00:00:00.000Z",
    }));
    const options: KicadPlaneContactsOptions = {
      pcbPath, expectedSourceIdentity: contentIdentity(pcbSource), runtimeRoot,
      manifest: { path: manifestPath, contentIdentity: contentIdentity(manifestBytes) },
      helper: { path: helperPath, contentIdentity: contentIdentity(helperSource) },
      outputRoot, environment: { SystemRoot: windowsRoot, WINDIR: windowsRoot, PATH: system32 }, runner,
    };
    const reader = await createKicadPlaneContactsReader(options);
    return { root, options, reader, runner, report, manifest, pcbSource, cleanup: () => cleanupPlaneContactsFixture(root) };
  } catch (error) {
    await cleanupPlaneContactsFixture(root);
    throw error;
  }
}

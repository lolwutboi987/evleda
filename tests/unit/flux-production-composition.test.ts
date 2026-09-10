import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalApiServer as createRealLocalApiServer } from "../../src/api/server.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { CanonicalIdentity } from "../../src/domain/types.js";
import {
  ProcessTreeTerminationUnconfirmedError,
  type BoundedProcessOptions,
  type BoundedProcessRunner,
} from "../../src/integrations/bounded-process.js";
import {
  CODEX_CLI_ISOLATION_ARGUMENTS,
  CODEX_CLI_ASTRA_CAPTURED_MODEL,
  CODEX_CLI_CAPTURED_MODEL,
  CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA,
  CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
  CLI_PROVIDER_SHUTDOWN_RESERVE_MS,
  CLI_PROVIDER_SHUTDOWN_WORST_CASE_MS,
  type CliProcess,
  type CliSpawner,
} from "../../src/harness/cli-providers.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-contract.js";
import {
  PACKAGED_DEEP_RULE_RESOURCE_IDENTITY,
  loadDeepRuleCatalog,
} from "../../src/harness/deep-rule-catalog.js";
import {
  FLUX_PRODUCTION_LIMITS,
  FLUX_PRODUCTION_INTERPRETATION_TIMEOUT_MS,
  FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPTS,
  FLUX_PRODUCTION_PROFILE_ENVIRONMENT,
  FLUX_PRODUCTION_PROFILE_SCHEMA_VERSION,
  FLUX_KICAD_TOOLCHAIN_PROFILE_SCHEMA_VERSION,
  FluxProductionCompositionError,
  createFluxSetupRequiredReadiness,
  readKicadNativeProfile,
  loadFluxProductionComposition as loadRealFluxProductionComposition,
  type FluxProductionCompositionDependencies,
  type FluxProductionProvider,
} from "../../src/flux/production-composition.js";
import { parsePeVersionInfo } from "../../src/flux/pe-version-info.js";
import { syntheticKiCadPe } from "../helpers/flux-kicad-toolchain.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..", "..");
const resourceRoot = path.resolve(packageRoot, "resources", "deep-pcb-rule-corpus", "v1");
const catalog = loadDeepRuleCatalog();
const catalogIdentity = canonicalIdentity(catalog, "evleda.deep-rule-catalog.v1");
const roots: string[] = [];
const samePathForTest = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.resolve(left).toLocaleLowerCase("en-US") === path.resolve(right).toLocaleLowerCase("en-US")
    : path.resolve(left) === path.resolve(right);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const pin = (number: string): string => `
      (pin passive line
        (at 0 0 0)
        (length 2.54)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "${number}" (effects (font (size 1.27 1.27)))))`;

const symbolLibrary = `(kicad_symbol_lib
  (version 20231120)
  (generator "evleda-production-composition-test")
  (generator_version "10.0")
  (symbol "R"
    (property "Reference" "R" (at 0 0 0))
    (property "Value" "R" (at 0 0 0))
    (property "ki_keywords" "resistor" (at 0 0 0))
    (property "ki_fp_filters" "R_*" (at 0 0 0))
    (symbol "R_1_1"${pin("1")}${pin("2")})))
`;

const footprint = `(footprint "R_0603_1608Metric"
  (version 20240108)
  (generator "evleda-production-composition-test")
  (layer "F.Cu")
  (fp_rect (start -2 -2) (end 2 2) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
  (fp_rect (start -1 -1) (end 1 1) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab"))
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste"))
  (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste")))
`;

const electrical = (voltage: number) => ({
  voltage: { minimumV: voltage, nominalV: voltage, maximumV: voltage },
  current: { nominalA: 0.01, maximumContinuousA: 0.01, peakA: 0.01, peakDurationMs: 1_000 },
  speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null },
});

const resolvedDraft = () => ({
  schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
  kind: "pcb_design_intent_draft",
  scope: {
    sheetCount: 1,
    componentUnitPolicy: "single_unit",
    board: { shape: "rectangle", widthMm: 20, heightMm: 15, layerCount: 2, copperLayers: ["F.Cu", "B.Cu"] },
  },
  components: [{
    reference: "R1",
    symbolLibId: "Device:R",
    value: "1k",
    footprintLibId: "Resistor_SMD:R_0603_1608Metric",
    unit: 1,
    pins: [
      { pin: "1", assignment: { kind: "net", net: "LOOP" } },
      { pin: "2", assignment: { kind: "net", net: "LOOP" } },
    ],
  }],
  nets: [{
    name: "LOOP",
    role: "passive",
    endpoints: [{ reference: "R1", pin: "1" }, { reference: "R1", pin: "2" }],
    electrical: electrical(0),
    netClassId: "DEFAULT",
  }],
  netClasses: [{
    id: "DEFAULT",
    traceWidthMm: 0.25,
    clearanceMm: 0.2,
    copperToEdgeMm: 0.3,
    allowedLayers: ["F.Cu", "B.Cu"],
  }],
  placementConstraints: [{
    reference: "R1",
    side: "front",
    regionMm: { minXmm: 1, maxXmm: 19, minYmm: 1, maxYmm: 14 },
    allowedRotationsDeg: [0, 90, 180, 270],
    minimumEdgeClearanceMm: 1,
    minimumCourtyardClearanceMm: 0.25,
    edgePreference: "none",
  }],
  routingConstraints: {
    cornerStyle: "miter_45",
    maximumTurnAngleDeg: 45,
    minimumStraightBeforeTurnMm: 0.25,
    allowRightAngleCorners: false,
    allowAcuteInteriorCorners: false,
    allowBacktracking: false,
    allowSelfIntersections: false,
    viaPolicy: { mode: "forbidden", maxTotal: 0 },
    nets: [{
      net: "LOOP",
      topology: "point_to_point",
      preferredLayer: "F.Cu",
      maxVias: 0,
      routeLength: { mode: "unbounded" },
    }],
  },
  unresolved: [],
});

interface TestFixture {
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly profilePath: string;
  profile: Record<string, any>;
  rewrite(): Promise<void>;
}

const createFixture = async (provider: FluxProductionProvider = "openai"): Promise<TestFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-production-composition-"));
  const inspectionAuthorityRoot = await mkdtemp(path.join(tmpdir(), "evleda-inspection-authority-"));
  const inspectionRuntimeParentRoot = await mkdtemp(path.join(tmpdir(), "evleda-inspection-runtime-"));
  const inspectionIpcSocketParentRoot = await mkdtemp(path.join(tmpdir(), "evleda-inspection-ipc-"));
  roots.push(root, inspectionAuthorityRoot, inspectionRuntimeParentRoot, inspectionIpcSocketParentRoot);
  const sourceRoot = path.join(root, "source");
  const workspaceRoot = path.join(root, "workspace");
  const symbolRoot = path.join(root, "kicad-10", "symbols");
  const footprintRoot = path.join(root, "kicad-10", "footprints");
  const footprintDirectory = path.join(footprintRoot, "Resistor_SMD.pretty");
  const kicadBinRoot = path.join(root, "kicad-10", "bin");
  const kicadCliPath = path.join(kicadBinRoot, "kicad-cli.exe");
  const pcbnewPath = path.join(kicadBinRoot, "pcbnew.exe");
  const kicadMcpRuntimeLockPath = path.join(inspectionAuthorityRoot, "inspection-bridge.lock.json");
  const inspectionBundleRoot = path.join(inspectionAuthorityRoot, "bundle");
  const inspectionManifestPath = path.join(inspectionAuthorityRoot, "manifest.json");
  const inspectionPythonRelativePath = "environment/Scripts/python.exe";
  const inspectionPythonPath = path.join(inspectionBundleRoot, ...inspectionPythonRelativePath.split("/"));
  const inspectionEntrypointRelativePath = "launcher.py";
  const inspectionEntrypointPath = path.join(inspectionBundleRoot, inspectionEntrypointRelativePath);
  const inspectionTerminatorPath = path.join(inspectionBundleRoot, "process-tree-terminator.exe");
  const profilePath = path.join(root, "flux-production-profile.json");
  const executablePath = path.join(root, process.platform === "win32" ? "provider-cli.exe" : "provider-cli");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(symbolRoot, { recursive: true }),
    mkdir(footprintDirectory, { recursive: true }),
    mkdir(kicadBinRoot, { recursive: true }),
    mkdir(path.dirname(inspectionPythonPath), { recursive: true }),
    mkdir(path.dirname(inspectionTerminatorPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(symbolRoot, "Device.kicad_sym"), symbolLibrary, "utf8"),
    writeFile(path.join(footprintDirectory, "R_0603_1608Metric.kicad_mod"), footprint, "utf8"),
    writeFile(executablePath, "fake pinned provider executable\n", "utf8"),
    writeFile(kicadCliPath, syntheticKiCadPe("kicad-cli")),
    writeFile(pcbnewPath, syntheticKiCadPe("pcbnew")),
    writeFile(kicadMcpRuntimeLockPath, '{"schemaVersion":2}\n', "utf8"),
    writeFile(inspectionManifestPath, '{"schemaVersion":1,"totalBytes":123}\n', "utf8"),
    writeFile(inspectionPythonPath, "synthetic inspection Python executable\n", "utf8"),
    writeFile(inspectionEntrypointPath, "synthetic inspection entrypoint\n", "utf8"),
    writeFile(inspectionTerminatorPath, "synthetic process-tree terminator\n", "utf8"),
  ]);
  const executableBytes = await readFile(executablePath);
  const executableIdentity = contentIdentity(executableBytes);
  const providerProfile = {
    provider,
    model: provider === "codex" ? CODEX_CLI_CAPTURED_MODEL : `${provider}-model-exact:2026-09-06`,
    tier: provider === "openai" ? "fast" : "provider-default",
    deadlineMs: FLUX_PRODUCTION_LIMITS.deadlineMs,
    ...((provider === "codex" || provider === "claude-cli") ? {
      executable: {
        path: executablePath,
        sha256: executableIdentity.digest,
        sizeBytes: executableIdentity.size,
        version: provider === "codex" ? "codex-cli 0.153.4" : `${provider} fake 1.2.3`,
      },
    } : {}),
    ...(provider === "codex" ? { allowCodexLocalRead: true } : {}),
  };
  const kicadCliIdentity = contentIdentity(await readFile(kicadCliPath));
  const pcbnewIdentity = contentIdentity(await readFile(pcbnewPath));
  const kicadMcpRuntimeLockIdentity = contentIdentity(await readFile(kicadMcpRuntimeLockPath));
  const inspectionManifestIdentity = contentIdentity(await readFile(inspectionManifestPath));
  const inspectionPythonIdentity = contentIdentity(await readFile(inspectionPythonPath));
  const inspectionEntrypointIdentity = contentIdentity(await readFile(inspectionEntrypointPath));
  const inspectionTerminatorIdentity = contentIdentity(await readFile(inspectionTerminatorPath));
  const inspectionPythonArgumentsSha256 = createHash("sha256")
    .update("evleda.kicad-mcp-arguments.v1\0", "utf8")
    .update(JSON.stringify(["-I", "-s", "-E", "-B", inspectionEntrypointPath]), "utf8")
    .digest("hex");
  const profile: Record<string, any> = {
    schemaVersion: FLUX_PRODUCTION_PROFILE_SCHEMA_VERSION,
    provider: providerProfile,
    kicadToolchain: {
      schemaVersion: FLUX_KICAD_TOOLCHAIN_PROFILE_SCHEMA_VERSION,
      binRoot: kicadBinRoot,
      kicadCli: {
        path: kicadCliPath,
        sha256: kicadCliIdentity.digest,
        sizeBytes: kicadCliIdentity.size,
        operationalVersion: "10.0.3",
        operationalCommit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
        peFileVersion: "10.0.3.49839",
        peProductVersion: "10.0.3",
      },
      pcbnew: {
        path: pcbnewPath,
        sha256: pcbnewIdentity.digest,
        sizeBytes: pcbnewIdentity.size,
        peFileVersion: "10.0.3.49839",
        peProductVersion: "10.0.3",
      },
    },
    kicadMcpRuntime: {
      schemaVersion: "evleda.flux-kicad-mcp-runtime-profile.v2",
      lock: {
        path: kicadMcpRuntimeLockPath,
        sha256: kicadMcpRuntimeLockIdentity.digest,
        sizeBytes: kicadMcpRuntimeLockIdentity.size,
      },
      runtimeBundle: {
        root: inspectionBundleRoot,
        manifest: {
          path: inspectionManifestPath,
          sha256: inspectionManifestIdentity.digest,
          sizeBytes: inspectionManifestIdentity.size,
        },
        expectedClosure: {
          fileCount: 3,
          totalBytes: 123,
          manifestIdentity: canonicalIdentity(
            { fixture: "inspection-manifest" },
            "evleda.kicad-mcp-runtime-manifest.v2",
          ),
          treeIdentity: canonicalIdentity(
            { fixture: "inspection-tree" },
            "evleda.kicad-mcp-inspection-runtime-tree.v1",
          ),
          python: {
            relativePath: inspectionPythonRelativePath,
            sha256: inspectionPythonIdentity.digest,
            sizeBytes: inspectionPythonIdentity.size,
          },
          entrypoint: {
            relativePath: inspectionEntrypointRelativePath,
            sha256: inspectionEntrypointIdentity.digest,
            sizeBytes: inspectionEntrypointIdentity.size,
          },
          protocol: {
            distribution: "kicad-mcp-pro",
            distributionVersion: "3.33.3",
            serverName: "kicad-mcp-pro",
            serverVersion: "1.29.1",
            transport: "stdio",
            modes: ["readonly", "write"],
          },
        },
      },
      runtimeParentRoot: inspectionRuntimeParentRoot,
      ipcSocketParentRoot: inspectionIpcSocketParentRoot,
      runtimePolicy: {
        allocation: "fresh-per-connect",
        cleanup: "required",
        dependencyNetwork: "disabled",
        packageResolution: "none",
        workingDirectory: "fresh-private",
        projectBinding: "post-connect-protocol",
        environmentFiles: "disabled",
        pythonLaunch: {
          flags: ["-I", "-s", "-E", "-B"],
          argumentCount: 5,
          argumentsSha256: inspectionPythonArgumentsSha256,
          bytecodeWrites: "disabled",
        },
        verificationTimeoutMs: 30_000,
      },
      processTreeSupervision: {
        platform: "win32",
        strategy: "taskkill-tree-before-sdk-close-v1",
        terminator: {
          path: inspectionTerminatorPath,
          relativePath: "process-tree-terminator.exe",
          sha256: inspectionTerminatorIdentity.digest,
          sizeBytes: inspectionTerminatorIdentity.size,
        },
        terminationTimeoutMs: 5_000,
        rootProof: "exact-child-process-handle-immediately-before-spawn",
        earlyRootExit: "zero-numeric-signal-retain-poison",
        activeCalls: "fence-abort-drain-before-cleanup",
        confirmation: "taskkill-success-plus-exact-root-exit-and-close",
        runtimeCleanup: "after-tree-confirmation-and-runtime-revalidation-only",
        unconfirmed: "retain-poison-no-retry",
      },
      connectionPolicy: {
        maxConnections: 8,
        concurrency: 1,
        reuse: "same-live-run-bounded",
        restart: "fail-closed-reallocate-reapprove",
        cleanup: "after-confirmed-session-and-editor-stop",
        unconfirmed: "retain-poison-no-retry",
      },
    },
    libraries: {
      kicadMajorVersion: 10,
      symbolRoot,
      footprintRoot,
      exactSymbolIds: ["Device:R"],
      exactFootprintIds: ["Resistor_SMD:R_0603_1608Metric"],
      stockSymbolNicknames: ["Device"],
      stockFootprintNicknames: ["Resistor_SMD"],
    },
    deepRules: {
      resourceRoot,
      resourceIdentity: PACKAGED_DEEP_RULE_RESOURCE_IDENTITY,
      catalogIdentity,
      selection: {
        maxRules: 24,
        maxPromptBytes: 8_192,
        maxPromptTokens: 8_192,
        featureCoveragePolicy: "require-all",
      },
    },
  };
  const environment: NodeJS.ProcessEnv = {
    EVLEDA_FLUX_SOURCE_ROOT: sourceRoot,
    EVLEDA_FLUX_WORKSPACE_ROOT: workspaceRoot,
    OPENAI_API_KEY: "openai-secret-must-never-leak",
    ANTHROPIC_API_KEY: "anthropic-secret-must-never-leak",
    CODEX_HOME: path.join(root, "codex-home"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude-home"),
    EVLEDA_KICAD_CLI: kicadCliPath,
    EVLEDA_PCBNEW: pcbnewPath,
    SYSTEMROOT: inspectionAuthorityRoot,
    WINDIR: inspectionAuthorityRoot,
  };
  const fixture: TestFixture = {
    root,
    environment,
    profilePath,
    profile,
    async rewrite() {
      const bytes = Buffer.from(`${JSON.stringify(fixture.profile)}\n`, "utf8");
      await writeFile(profilePath, bytes);
      const identity = contentIdentity(bytes);
      environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.path] = profilePath;
      environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.sha256] = identity.digest;
      environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.sizeBytes] = String(identity.size);
    },
  };
  await fixture.rewrite();
  return fixture;
};

const modelFor = (provider: FluxProductionProvider): string =>
  provider === "codex" ? CODEX_CLI_CAPTURED_MODEL : `${provider}-model-exact:2026-09-06`;

describe("native-only pinned profile reader", () => {
  it("reads optional reference coverage exact pin without starting a process", async () => {
    const fixture = await createFixture(); const helperPath = path.join(path.dirname(fixture.profilePath), "reference.exe");
    fixture.profile.kicadReferenceCoverage = { path: helperPath, sha256: "b".repeat(64), sizeBytes: 980480 };
    await fixture.rewrite();
    const native = await readKicadNativeProfile({ path: fixture.profilePath, contentIdentity: contentIdentity(await readFile(fixture.profilePath)) });
    expect(native.kicadReferenceCoverage).toEqual({ path: helperPath, identity: { algorithm: "sha256", digest: "b".repeat(64), size: 980480 } });
  });
  it.each([
    { path: "relative.exe", sha256: "a".repeat(64), sizeBytes: 1 },
    { path: path.resolve("reference.exe"), sha256: "bad", sizeBytes: 1 },
    { path: path.resolve("reference.exe"), sha256: "a".repeat(64), sizeBytes: 0 },
    { path: path.resolve("reference.exe"), sha256: "a".repeat(64), sizeBytes: 1, marginNm: 10 },
  ])("rejects invalid reference coverage configuration %j", async helper => {
    const fixture = await createFixture(); fixture.profile.kicadReferenceCoverage = helper; await fixture.rewrite();
    await expect(readKicadNativeProfile({ path: fixture.profilePath, contentIdentity: contentIdentity(await readFile(fixture.profilePath)) })).rejects.toThrow();
  });
  it("reads an optional exact calculator pin without starting a process", async () => {
    const fixture = await createFixture();
    const calculatorPath = path.join(path.dirname(fixture.profilePath), "calculator.exe");
    fixture.profile.kicadTransmissionLine = { path: calculatorPath, sha256: "a".repeat(64), sizeBytes: 1234 };
    await fixture.rewrite();
    const pin = contentIdentity(await readFile(fixture.profilePath));
    const native = await readKicadNativeProfile({ path: fixture.profilePath, contentIdentity: pin });
    expect(native.kicadTransmissionLine).toEqual({ path: calculatorPath,
      identity: { algorithm: "sha256", digest: "a".repeat(64), size: 1234 } });
  });

  it.each([
    { path: "relative.exe", sha256: "a".repeat(64), sizeBytes: 1234 },
    { path: path.resolve("calculator.exe"), sha256: "bad", sizeBytes: 1234 },
    { path: path.resolve("calculator.exe"), sha256: "a".repeat(64), sizeBytes: 0 },
    { path: path.resolve("calculator.exe"), sha256: "a".repeat(64), sizeBytes: 1234, command: "other" },
  ])("rejects invalid optional calculator configuration %j", async calculator => {
    const fixture = await createFixture(); fixture.profile.kicadTransmissionLine = calculator;
    await fixture.rewrite();
    const pin = contentIdentity(await readFile(fixture.profilePath));
    await expect(readKicadNativeProfile({ path: fixture.profilePath, contentIdentity: pin })).rejects.toThrow();
  });

  it("reads the native sections without requiring a valid provider or compiler", async () => {
    const fixture = await createFixture();
    fixture.profile.provider = { deliberatelyNotAProvider: true };
    fixture.profile.compiler = null;
    await fixture.rewrite();
    const pin = contentIdentity(await readFile(fixture.profilePath));
    const native = await readKicadNativeProfile({ path: fixture.profilePath, contentIdentity: pin });
    expect(native.kicadToolchain.kicadCli.operationalVersion).toBe("10.0.3");
    expect(native.kicadMcpRuntime.runtimeBundle.expectedClosure.protocol.distribution).toBe("kicad-mcp-pro");
    expect(native).not.toHaveProperty("provider");
    expect(native).not.toHaveProperty("compiler");
  });

  it("rejects changed profile bytes before returning native configuration", async () => {
    const fixture = await createFixture();
    const pin = contentIdentity(await readFile(fixture.profilePath));
    await writeFile(fixture.profilePath, "{}");
    await expect(readKicadNativeProfile({ path: fixture.profilePath, contentIdentity: pin })).rejects.toThrow();
  });
});

const fakeCodexCaptureIdentity = (fixture: TestFixture) => fixture.profile.provider.provider === "codex"
  ? {
      codexCapturedExecutableIdentityForTesting: {
        algorithm: "sha256" as const,
        digest: fixture.profile.provider.executable.sha256 as string,
        size: fixture.profile.provider.executable.sizeBytes as number,
      },
    }
  : {};

const fakeProcessRunner = (
  authenticated = true,
  actualVersion?: string,
): BoundedProcessRunner => async (options) => {
  if (path.basename(options.command).toLocaleLowerCase("en-US") === "kicad-cli.exe") {
    const stdout = options.args.join(" ") === "version --format commit"
      ? "146a4f2a7585c65bc580427a19b6fe2ec4a3f622\r\n"
      : options.args.join(" ") === "version" ? "10.0.3\r\n" : "";
    return {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      exitCode: stdout === "" ? 1 : 0,
      stdout,
      stderr: "",
      durationMs: 1,
      startedAt: "2026-09-06T00:00:00.000Z",
    };
  }
  const isVersion = options.args.length === 1 && options.args[0] === "--version";
  const isConfigurationPreflight = options.args[0] === "exec";
  const provider = options.command.includes("provider-cli")
    ? options.args[0] === "login" ? "codex" : options.args[0] === "auth" ? "claude-cli" : "unknown"
    : "unknown";
  const profileBytes = readFileSync(path.join(path.dirname(options.command), "flux-production-profile.json"), "utf8");
  const configured = JSON.parse(profileBytes) as { provider: { provider: string; version?: string; executable?: { version: string } } };
  const stdout = isVersion
    ? actualVersion ?? configured.provider.executable!.version
    : isConfigurationPreflight ? ""
    : provider === "codex"
      ? authenticated ? "Logged in using ChatGPT" : "Not logged in"
      : JSON.stringify({ loggedIn: authenticated, authMethod: authenticated ? "oauth" : "none" });
  return {
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    exitCode: isConfigurationPreflight ? 1 : authenticated ? 0 : isVersion ? 0 : 1,
    stdout,
    stderr: isConfigurationPreflight ? "Reading prompt from stdin...\nNo prompt provided via stdin.\n" : "",
    durationMs: 1,
    startedAt: "2026-09-06T00:00:00.000Z",
  };
};

const syntheticKiCadPeVersion = (
  role: "kicad-cli" | "pcbnew",
  major: number,
  patchVersion: number,
): Buffer => {
  const bytes = Buffer.from(syntheticKiCadPe(role));
  const from = Buffer.from("10.0.3", "utf16le");
  const to = Buffer.from(`${major}.0.${patchVersion}`, "utf16le");
  if (to.byteLength !== from.byteLength) throw new Error("Synthetic version must retain the fixture width");
  for (let offset = bytes.indexOf(from); offset >= 0; offset = bytes.indexOf(from, offset + to.byteLength)) {
    to.copy(bytes, offset);
  }
  const signature = bytes.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
  if (signature < 0) throw new Error("Synthetic PE fixed-version signature is missing");
  bytes.writeUInt32LE(major << 16, signature + 8);
  bytes.writeUInt32LE(major << 16, signature + 16);
  bytes.writeUInt32LE((patchVersion << 16) | 49_839, signature + 12);
  bytes.writeUInt32LE((patchVersion << 16) | 49_839, signature + 20);
  return bytes;
};

const createSyntheticKicadMcpRuntime: NonNullable<
  FluxProductionCompositionDependencies["createKicadMcpRuntime"]
> = async ({
  lockFile,
  runtimeBundle,
  runtimeParentRoot,
  ipcSocketParentRoot,
  verificationTimeoutMs,
  processTreeSupervision,
  kicadCli,
  protectedRoots,
  environment: bridgeEnvironment,
}) => {
  if (verificationTimeoutMs !== 30_000) throw new Error("Inspection bridge received a drifting verification timeout");
  if (processTreeSupervision.strategy !== "taskkill-tree-before-sdk-close-v1"
    || processTreeSupervision.timeoutMs !== 5_000) {
    throw new Error("Inspection bridge received a drifting process-tree policy");
  }
  if (Object.keys(bridgeEnvironment).some((key) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)/u.test(key))) {
    throw new Error("Inspection bridge received a forbidden environment key");
  }
  const identity = canonicalIdentity({
    schemaVersion: "evleda.kicad-mcp-runtime.v1",
    lockContentIdentity: lockFile.contentIdentity,
    runtimeManifestContentIdentity: runtimeBundle.manifestFile.contentIdentity,
    expectedClosure: runtimeBundle.expectedClosure,
    runtimeBundlePathIdentity: canonicalIdentity({ path: runtimeBundle.root }, "evleda.test-path.v1"),
    runtimeParentPathIdentity: canonicalIdentity({ path: runtimeParentRoot }, "evleda.test-path.v1"),
    ipcSocketParentPathIdentity: canonicalIdentity({ path: ipcSocketParentRoot }, "evleda.test-path.v1"),
    kicadCliContentIdentity: kicadCli.contentIdentity,
    protectedRootSetIdentity: canonicalIdentity([...protectedRoots].sort(), "evleda.test-protected-roots.v1"),
    environmentKeys: Object.keys(bridgeEnvironment).sort(),
    verificationTimeoutMs,
    processTreeSupervision: {
      strategy: processTreeSupervision.strategy,
      terminatorContentIdentity: processTreeSupervision.terminator.contentIdentity,
      timeoutMs: processTreeSupervision.timeoutMs,
    },
  }, "evleda.kicad-mcp-runtime.v1");
  const inspectionBridgeIdentity = canonicalIdentity(
    { runtimeIdentity: identity, capability: "readonly-inspection" },
    "evleda.kicad-mcp-inspection-bridge.v2",
  );
  const executionBridgeIdentity = canonicalIdentity(
    { runtimeIdentity: identity, capability: "full-execution" },
    "evleda.kicad-mcp-execution-bridge.v1",
  );
  return Object.freeze({
    identity,
    inspectionBridgeIdentity,
    executionBridgeIdentity,
    allocateIpcSocket: async ({ runBindingIdentity }: Readonly<{
      readonly runBindingIdentity: CanonicalIdentity;
    }>) => Object.freeze({
      endpoint: "ipc://synthetic/inspection.sock",
      identity: canonicalIdentity({ runBindingIdentity }, "evleda.kicad-api-socket-binding.v1"),
    }),
    assertIpcSocket: async (binding: Readonly<{
      readonly endpoint: string;
      readonly identity: CanonicalIdentity;
    }>) => Object.freeze({
      bindingIdentity: binding.identity,
      remainingConnections: 8,
      active: false,
    }),
    releaseIpcSocket: async () => "released" as const,
    getEditorLaunchContext: async () => { throw new Error("Synthetic editor context must not launch"); },
    bindSession: async ({ runBindingIdentity, ipcSocket, mode, requiredTools, roots: sessionRoots }: Readonly<{
      readonly runBindingIdentity: CanonicalIdentity;
      readonly ipcSocket: Readonly<{ readonly endpoint: string; readonly identity: CanonicalIdentity }>;
      readonly mode: "readonly" | "write";
      readonly requiredTools: readonly string[];
      readonly roots: Readonly<{
        readonly workspaceRoot: string;
        readonly projectRoot: string;
        readonly outputRoot: string;
      }>;
    }>) => {
      const semanticIdentity = canonicalIdentity({
        runBindingIdentity,
        ipcSocketIdentity: ipcSocket.identity,
        mode,
        requiredTools: [...requiredTools],
        rootsIdentity: canonicalIdentity(sessionRoots, "evleda.test-session-roots.v1"),
      }, "evleda.kicad-mcp-session-semantic-authority.v1");
      const sessionIdentity = canonicalIdentity({
        semanticIdentity,
        runtimeAllocation: "synthetic",
      }, "evleda.kicad-mcp-session-authority.v1");
      return Object.freeze({
        identity: sessionIdentity,
        semanticIdentity,
        disposeUnused: async () => "disposed" as const,
        connect: async () => { throw new Error("Synthetic session authority must not connect"); },
      });
    },
    assertCurrent: async () => undefined,
    connect: async () => { throw new Error("Synthetic inspection bridge must not connect"); },
  });
};

const loadFluxProductionComposition = async (
  environment: NodeJS.ProcessEnv,
  dependencies: FluxProductionCompositionDependencies = {},
) => await loadRealFluxProductionComposition(environment, {
  processRunner: fakeProcessRunner(),
  createKicadMcpRuntime: createSyntheticKicadMcpRuntime,
  ...dependencies,
});

const createLocalApiServer = async (
  environment: NodeJS.ProcessEnv,
  dependencies: NonNullable<Parameters<typeof createRealLocalApiServer>[1]> = {},
) => await createRealLocalApiServer(environment, {
  ...dependencies,
  fluxProduction: {
    createKicadMcpRuntime: createSyntheticKicadMcpRuntime,
    ...dependencies.fluxProduction,
  },
});

class FakeCliProcess extends EventEmitter implements CliProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = undefined;
  killed = false;
  kill(): boolean {
    if (!this.killed) queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    this.killed = true;
    return true;
  }
}

const providerTurn = () => ({
  message: { role: "assistant" as const, content: "Submitting the closed intent." },
  toolCalls: [{ id: "intent-1", name: "submit_design_intent", arguments: resolvedDraft() }],
  stopReason: "tool_calls" as const,
});

const codexProviderEnvelope = (): string => JSON.stringify({
  schemaVersion: CODEX_CLI_TURN_ENVELOPE_SCHEMA_VERSION,
  messageContent: providerTurn().message.content,
  hasToolCalls: true,
  toolCalls: providerTurn().toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    argumentsJson: JSON.stringify(call.arguments),
  })),
  stopReason: providerTurn().stopReason,
});

const fakeCliSpawn = (seen: Array<Readonly<{ args: readonly string[]; env: NodeJS.ProcessEnv }>>): CliSpawner =>
  (_command, args, options) => {
    seen.push({ args, env: options.env ?? {} });
    const child = new FakeCliProcess();
    child.stdin.resume();
    child.stdin.on("finish", () => {
      if (args.includes("exec")) {
        const output = args[args.indexOf("--output-last-message") + 1]!;
        void writeFile(output, codexProviderEnvelope(), "utf8").then(() => child.emit("close", 0, null));
      } else {
        child.stdout.end(JSON.stringify({
          type: "result",
          is_error: false,
          structured_output: providerTurn(),
        }));
        child.emit("close", 0, null);
      }
    });
    return child;
  };

const fakeFetchFor = (provider: "openai" | "anthropic", seen: unknown[]) => async (_input: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  seen.push({ body, headers: Object.fromEntries(new Headers(init?.headers).entries()), signal: init?.signal });
  const response = provider === "openai"
    ? {
        status: "completed",
        error: null,
        incomplete_details: null,
        id: "resp-production-test",
        output: [{
          id: "fc-production-test",
          type: "function_call",
          status: "completed",
          call_id: "intent-1",
          name: "submit_design_intent",
          arguments: JSON.stringify(resolvedDraft()),
        }],
      }
    : {
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "intent-1",
          name: "submit_design_intent",
          input: resolvedDraft(),
        }],
      };
  return new Response(JSON.stringify(response), { status: 200 });
};

describe("Flux production composition", () => {
  it("reserves a strict teardown margin inside the public 270-second interpretation deadline", () => {
    expect(FLUX_PRODUCTION_INTERPRETATION_TIMEOUT_MS).toBe(270_000);
    expect(FLUX_PRODUCTION_LIMITS.deadlineMs).toBe(270_000);
    expect(CLI_PROVIDER_SHUTDOWN_WORST_CASE_MS).toBe(6_250);
    expect(CLI_PROVIDER_SHUTDOWN_RESERVE_MS).toBe(8_000);
    expect(CLI_PROVIDER_SHUTDOWN_RESERVE_MS).toBeGreaterThan(CLI_PROVIDER_SHUTDOWN_WORST_CASE_MS);
    expect(FLUX_PRODUCTION_LIMITS.deadlineMs - CLI_PROVIDER_SHUTDOWN_RESERVE_MS).toBe(262_000);
    expect(
      FLUX_PRODUCTION_LIMITS.deadlineMs
      - CLI_PROVIDER_SHUTDOWN_RESERVE_MS
      + CLI_PROVIDER_SHUTDOWN_WORST_CASE_MS,
    ).toBeLessThan(FLUX_PRODUCTION_LIMITS.deadlineMs);
  });

  it("returns a closed, immutable setup-required readiness projection", () => {
    const readiness = createFluxSetupRequiredReadiness(["FLUX_DISABLED", "FLUX_DISABLED"]);
    expect(readiness).toEqual({
      schemaVersion: "evleda.flux-readiness.v1",
      configured: false,
      status: "setup_required",
      reasonCodes: ["FLUX_DISABLED"],
      provider: null,
      compiler: null,
      toolchain: null,
      kicadMcpRuntime: null,
      diagnostic: null,
    });
    expect(Object.isFrozen(readiness)).toBe(true);
    expect(Object.isFrozen(readiness.reasonCodes)).toBe(true);
  });

  it.each(["openai", "anthropic", "codex", "claude-cli"] as const)(
    "constructs the exact %s adapter/profile and carries that identity through interpretation",
    async (provider) => {
      const fixture = await createFixture(provider);
      const transportCalls: unknown[] = [];
      const spawnCalls: Array<Readonly<{ args: readonly string[]; env: NodeJS.ProcessEnv }>> = [];
      const composition = await loadFluxProductionComposition(fixture.environment, {
        ...fakeCodexCaptureIdentity(fixture),
        ...(provider === "openai" || provider === "anthropic"
          ? { fetch: fakeFetchFor(provider, transportCalls) }
          : { cliSpawn: fakeCliSpawn(spawnCalls), processRunner: fakeProcessRunner() }),
        temporaryDirectory: fixture.root,
      });
      expect(composition.readiness).toMatchObject({
        configured: true,
        status: "ready",
        reasonCodes: [],
        provider: {
          provider,
          model: modelFor(provider),
          requestedTier: provider === "openai" ? "fast" : "provider-default",
          canonicalTier: provider === "openai" ? "priority" : "provider-default",
          providerProfileIdentity: composition.providerProfile.identity,
          localReadCapability: provider === "codex" ? "read_only_host_files" : "none",
          configurationPreflight: provider === "codex" ? {
            status: "passed",
            imageInspectionPolicy: "disabled_by_pinned_feature",
          } : null,
        },
        compiler: {
          exactSymbolCount: 1,
          exactFootprintCount: 1,
          symbolNicknameCount: 1,
          footprintNicknameCount: 1,
        },
        toolchain: {
          identity: composition.kicadToolchain.identity,
          kicadCli: {
            identity: composition.kicadToolchain.kicadCli.identity,
            operationalVersion: "10.0.3",
            operationalCommit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
            peFileVersion: "10.0.3.49839",
            peProductVersion: "10.0.3",
          },
          pcbnew: {
            identity: composition.kicadToolchain.pcbnew.identity,
            peFileVersion: "10.0.3.49839",
            peProductVersion: "10.0.3",
          },
        },
        kicadMcpRuntime: {
          identity: composition.kicadMcpRuntime.identity,
          inspectionBridgeIdentity: composition.kicadMcpRuntime.inspectionBridgeIdentity,
          executionBridgeIdentity: composition.kicadMcpRuntime.executionBridgeIdentity,
          connectionPolicy: {
            maxConnections: 8,
            concurrency: 1,
            reuse: "same-live-run-bounded",
            restart: "fail-closed-reallocate-reapprove",
            cleanup: "after-confirmed-session-and-editor-stop",
            unconfirmed: "retain-poison-no-retry",
          },
        },
      });
      expect(composition.providerProfile.model).toBe(modelFor(provider));
      expect(Object.isFrozen(composition.providerProfile)).toBe(true);
      expect(Object.isFrozen(composition.readiness.provider)).toBe(true);
      expect(Object.isFrozen(composition.readiness.kicadMcpRuntime)).toBe(true);
      const interpreted = await composition.contractInterpreter.interpretCompilation({
        prompt: "Create a one-resistor closed-loop PCB candidate.",
        clarificationAnswers: [],
      });
      expect(interpreted.publicState.disposition).toBe("ready");
      expect(interpreted.bundle).not.toBeNull();
      expect(interpreted.bundle?.classification).toBe("candidate-only");
      expect(interpreted.bundle?.fabricationAuthorized).toBe(false);
      expect(interpreted.bundle?.releaseAuthorized).toBe(false);
      expect(interpreted.publicState.interpreterReceipt).toMatchObject({
        schemaVersion: "evleda.flux-interpreter-receipt.v2",
        provider,
        providerProfile: composition.providerProfile,
        providerProfileIdentity: composition.providerProfile.identity,
      });
      if (provider === "openai") {
        const call = transportCalls[0] as { body: Record<string, unknown> };
        expect(call.body).toMatchObject({
          model: "openai-model-exact:2026-09-06",
          service_tier: "priority",
          store: false,
          max_output_tokens: 4_096,
        });
      } else if (provider === "anthropic") {
        const call = transportCalls[0] as { body: Record<string, unknown> };
        expect(call.body).toMatchObject({
          model: "anthropic-model-exact:2026-09-06",
          max_tokens: 4_096,
        });
      } else {
        expect(spawnCalls).toHaveLength(1);
        expect(spawnCalls[0]!.args).toContain(modelFor(provider));
        expect(spawnCalls[0]!.env).not.toHaveProperty("EVLEDA_FLUX_PRODUCTION_PROFILE_PATH");
        if (provider === "codex") {
          expect(spawnCalls[0]!.args).toEqual(expect.arrayContaining([
            "exec", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules",
          ]));
        } else {
          expect(spawnCalls[0]!.args).toEqual(expect.arrayContaining([
            "--print", "--tools", "", "--no-session-persistence",
          ]));
        }
      }
      const publicJson = JSON.stringify(composition.readiness);
      expect(publicJson).not.toContain(fixture.root);
      expect(publicJson).not.toContain("openai-secret-must-never-leak");
      expect(publicJson).not.toContain("anthropic-secret-must-never-leak");
    },
    30_000,
  );

  it("stores and re-verifies a ready bundle with the same production dependencies", async () => {
    const fixture = await createFixture("openai");
    const composition = await loadFluxProductionComposition(fixture.environment, {
      fetch: fakeFetchFor("openai", []),
    });
    const interpreted = await composition.contractInterpreter.interpretCompilation({
      prompt: "Create a one-resistor closed-loop PCB candidate.",
      clarificationAnswers: [],
    });
    const reference = await composition.compilationBundleStore.put(interpreted.bundle);
    const readback = await composition.compilationBundleStore.get(reference);
    expect(canonicalJson(readback)).toBe(canonicalJson(interpreted.bundle));
  }, 30_000);

  it("fails before composition for missing profile pins, digest/size drift, malformed profiles, and invalid tiers", async () => {
    const missing = await createFixture("openai");
    delete missing.environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.path];
    await expect(loadFluxProductionComposition(missing.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_MISSING",
    });

    const digest = await createFixture("openai");
    digest.environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.sha256] = "0".repeat(64);
    await expect(loadFluxProductionComposition(digest.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_INVALID",
    });

    const size = await createFixture("openai");
    size.environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.sizeBytes] = "999999";
    await expect(loadFluxProductionComposition(size.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_INVALID",
    });

    const malformed = await createFixture("openai");
    malformed.profile.unexpected = true;
    const malformedDataDirectory = path.join(malformed.root, "must-not-exist-after-malformed-profile");
    malformed.environment.EVLEDA_DATA_DIR = malformedDataDirectory;
    await malformed.rewrite();
    await expect(loadFluxProductionComposition(malformed.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_INVALID",
    });
    await expect(createLocalApiServer(malformed.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_INVALID",
    });
    await expect(access(malformedDataDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const tier = await createFixture("anthropic");
    tier.profile.provider.tier = "fast";
    await tier.rewrite();
    await expect(loadFluxProductionComposition(tier.environment)).rejects.toMatchObject({
      reasonCode: "PROVIDER_NOT_CONFIGURED",
    });

    const linkedProfile = await createFixture("openai");
    const realDirectory = path.join(linkedProfile.root, "real-profile-directory");
    const linkedDirectory = path.join(linkedProfile.root, "linked-profile-directory");
    await mkdir(realDirectory);
    const linkedBytes = await readFile(linkedProfile.profilePath);
    const realProfilePath = path.join(realDirectory, "profile.json");
    await writeFile(realProfilePath, linkedBytes);
    await symlink(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    linkedProfile.environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.path] = path.join(linkedDirectory, "profile.json");
    await expect(loadFluxProductionComposition(linkedProfile.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_INVALID",
    });
  }, 30_000);

  it("rejects missing, linked, noncanonical, and overlapping roots without mutating them", async () => {
    const missing = await createFixture();
    missing.profile.libraries.symbolRoot = path.join(missing.root, "absent-symbols");
    await missing.rewrite();
    await expect(loadFluxProductionComposition(missing.environment)).rejects.toMatchObject({
      reasonCode: "KICAD_LIBRARY_UNAVAILABLE",
    });

    const linked = await createFixture();
    const linkPath = path.join(linked.root, "linked-symbols");
    await symlink(linked.profile.libraries.symbolRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
    linked.profile.libraries.symbolRoot = linkPath;
    await linked.rewrite();
    await expect(loadFluxProductionComposition(linked.environment)).rejects.toMatchObject({
      reasonCode: "KICAD_LIBRARY_UNAVAILABLE",
    });

    const noncanonical = await createFixture();
    noncanonical.profile.libraries.symbolRoot = path.join(noncanonical.profile.libraries.symbolRoot, "..");
    await noncanonical.rewrite();
    await expect(loadFluxProductionComposition(noncanonical.environment)).rejects.toMatchObject({
      reasonCode: "KICAD_LIBRARY_UNAVAILABLE",
    });

    const overlap = await createFixture();
    overlap.environment.EVLEDA_FLUX_WORKSPACE_ROOT = overlap.profile.libraries.symbolRoot;
    await expect(loadFluxProductionComposition(overlap.environment)).rejects.toMatchObject({
      reasonCode: "KICAD_LIBRARY_UNAVAILABLE",
    });
  }, 30_000);

  it("rejects malformed, missing, duplicate, unsorted, and nickname-unbound exact library IDs", async () => {
    const malformed = await createFixture();
    malformed.profile.libraries.exactSymbolIds = ["not-an-id"];
    await malformed.rewrite();
    await expect(loadFluxProductionComposition(malformed.environment)).rejects.toMatchObject({ reasonCode: "KICAD_LIBRARY_UNAVAILABLE" });

    const missing = await createFixture();
    missing.profile.libraries.exactSymbolIds = ["Device:Missing"];
    await missing.rewrite();
    await expect(loadFluxProductionComposition(missing.environment)).rejects.toMatchObject({ reasonCode: "KICAD_LIBRARY_UNAVAILABLE" });

    const duplicate = await createFixture();
    duplicate.profile.libraries.exactSymbolIds = ["Device:R", "Device:R"];
    await duplicate.rewrite();
    await expect(loadFluxProductionComposition(duplicate.environment)).rejects.toMatchObject({ reasonCode: "KICAD_LIBRARY_UNAVAILABLE" });

    const unbound = await createFixture();
    unbound.profile.libraries.stockSymbolNicknames = ["Connector_Generic", "Device"];
    await unbound.rewrite();
    await expect(loadFluxProductionComposition(unbound.environment)).rejects.toMatchObject({ reasonCode: "KICAD_LIBRARY_UNAVAILABLE" });
  }, 30_000);

  it("requires the closed v2 KiCad toolchain profile and rejects legacy or extra-bearing shapes", async () => {
    const legacy = await createFixture("openai");
    legacy.profile.schemaVersion = "evleda.flux-production-profile.v1";
    delete legacy.profile.kicadToolchain;
    delete legacy.profile.kicadMcpRuntime;
    await legacy.rewrite();
    await expect(loadFluxProductionComposition(legacy.environment)).rejects.toMatchObject({ reasonCode: "KICAD_TOOLCHAIN_UNAVAILABLE" });

    const missing = await createFixture("openai");
    delete missing.profile.kicadToolchain;
    await missing.rewrite();
    await expect(loadFluxProductionComposition(missing.environment)).rejects.toMatchObject({ reasonCode: "KICAD_TOOLCHAIN_UNAVAILABLE" });

    const extra = await createFixture("openai");
    extra.profile.kicadToolchain.privatePath = "C:\\private\\pcbnew.exe";
    await extra.rewrite();
    await expect(loadFluxProductionComposition(extra.environment)).rejects.toMatchObject({ reasonCode: "KICAD_TOOLCHAIN_UNAVAILABLE" });
  });

  it("serves legacy profile rejection only as setup-required readiness without mounting Flux", async () => {
    const fixture = await createFixture("openai");
    fixture.profile.schemaVersion = "evleda.flux-production-profile.v1";
    delete fixture.profile.kicadToolchain;
    delete fixture.profile.kicadMcpRuntime;
    fixture.environment.EVLEDA_DATA_DIR = path.join(fixture.root, "legacy-profile-app-data");
    await fixture.rewrite();
    const { app, flux } = await createLocalApiServer(fixture.environment);
    try {
      expect(flux).toBeUndefined();
      const response = await app.inject({ method: "GET", url: "/api/v1/flux/readiness" });
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toEqual({
        schemaVersion: "evleda.flux-readiness.v1",
        configured: false,
        status: "setup_required",
        reasonCodes: ["KICAD_TOOLCHAIN_UNAVAILABLE"],
        provider: null,
        compiler: null,
        toolchain: null,
        kicadMcpRuntime: null,
        diagnostic: null,
      });
      expect((await app.inject({ method: "GET", url: "/api/v1/flux/sources" })).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("serves only an exact otherwise-valid v2 or v3-minus-bridge profile as bridge setup required", async () => {
    for (const schemaVersion of ["evleda.flux-production-profile.v2", FLUX_PRODUCTION_PROFILE_SCHEMA_VERSION]) {
      const fixture = await createFixture("openai");
      fixture.profile.schemaVersion = schemaVersion;
      delete fixture.profile.kicadMcpRuntime;
      await fixture.rewrite();
      const { app, flux } = await createLocalApiServer(fixture.environment);
      try {
        expect(flux).toBeUndefined();
        const readiness = await app.inject({ method: "GET", url: "/api/v1/flux/readiness" });
        expect(readiness.statusCode).toBe(200);
        expect(readiness.json().result).toEqual({
          schemaVersion: "evleda.flux-readiness.v1",
          configured: false,
          status: "setup_required",
          reasonCodes: ["KICAD_MCP_RUNTIME_UNAVAILABLE"],
          provider: null,
          compiler: null,
          toolchain: null,
          kicadMcpRuntime: null,
          diagnostic: null,
        });
        expect((await app.inject({ method: "GET", url: "/api/v1/flux/policy" })).statusCode).toBe(503);
      } finally {
        await app.close();
      }
    }

    const extra = await createFixture("openai");
    delete extra.profile.kicadMcpRuntime;
    extra.profile.unexpected = true;
    await extra.rewrite();
    await expect(createLocalApiServer(extra.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_INVALID",
    });
  });

  it("rejects malformed bridge profiles and lock drift before invoking the bridge factory", async () => {
    const malformed = await createFixture("openai");
    malformed.profile.kicadMcpRuntime.privatePath = "C:\\private\\bridge";
    await malformed.rewrite();
    await expect(loadFluxProductionComposition(malformed.environment)).rejects.toMatchObject({
      reasonCode: "KICAD_MCP_RUNTIME_UNAVAILABLE",
    });

    const drifted = await createFixture("openai");
    drifted.profile.kicadMcpRuntime.lock.sha256 = "0".repeat(64);
    await drifted.rewrite();
    let factoryCalls = 0;
    await expect(loadFluxProductionComposition(drifted.environment, {
      createKicadMcpRuntime: async () => {
        factoryCalls += 1;
        throw new Error("must not be invoked");
      },
    })).rejects.toMatchObject({ reasonCode: "KICAD_MCP_RUNTIME_UNAVAILABLE" });
    expect(factoryCalls).toBe(0);

    const overlap = await createFixture("openai");
    const sourceLockPath = path.join(overlap.environment.EVLEDA_FLUX_SOURCE_ROOT!, "inspection-bridge.lock.json");
    const sourceLockBytes = await readFile(overlap.profile.kicadMcpRuntime.lock.path);
    await writeFile(sourceLockPath, sourceLockBytes);
    const sourceLockIdentity = contentIdentity(sourceLockBytes);
    overlap.profile.kicadMcpRuntime.lock = {
      path: sourceLockPath,
      sha256: sourceLockIdentity.digest,
      sizeBytes: sourceLockIdentity.size,
    };
    await overlap.rewrite();
    let processCalls = 0;
    await expect(loadFluxProductionComposition(overlap.environment, {
      processRunner: async (options) => {
        processCalls += 1;
        return await fakeProcessRunner()(options);
      },
      createKicadMcpRuntime: async () => {
        factoryCalls += 1;
        throw new Error("must not be invoked");
      },
    })).rejects.toMatchObject({ reasonCode: "KICAD_MCP_RUNTIME_UNAVAILABLE" });
    expect(processCalls).toBe(0);
    expect(factoryCalls).toBe(0);
  });

  it("rejects malformed or overlapping realized inspection-runtime closure authority before probes", async () => {
    const cases: Array<readonly [string, (fixture: TestFixture) => void]> = [
      ["manifest extra", (fixture) => { fixture.profile.kicadMcpRuntime.runtimeBundle.manifest.extra = true; }],
      ["zero files", (fixture) => { fixture.profile.kicadMcpRuntime.runtimeBundle.expectedClosure.fileCount = 0; }],
      ["manifest total drift", (fixture) => { fixture.profile.kicadMcpRuntime.runtimeBundle.expectedClosure.totalBytes += 1; }],
      ["legacy readonly manifest identity", (fixture) => {
        fixture.profile.kicadMcpRuntime.runtimeBundle.expectedClosure.manifestIdentity.schemaVersion =
          "evleda.kicad-mcp-inspection-runtime-manifest.v1";
      }],
      ["invalid tree identity", (fixture) => { fixture.profile.kicadMcpRuntime.runtimeBundle.expectedClosure.treeIdentity.digest = "z".repeat(64); }],
      ["Python traversal", (fixture) => { fixture.profile.kicadMcpRuntime.runtimeBundle.expectedClosure.python.relativePath = "../python.exe"; }],
      ["incomplete mode authority", (fixture) => { fixture.profile.kicadMcpRuntime.runtimeBundle.expectedClosure.protocol.modes = ["readonly"]; }],
      ["reordered mode authority", (fixture) => { fixture.profile.kicadMcpRuntime.runtimeBundle.expectedClosure.protocol.modes = ["write", "readonly"]; }],
      ["networked dependency resolution", (fixture) => { fixture.profile.kicadMcpRuntime.runtimePolicy.dependencyNetwork = "enabled"; }],
      ["missing no-bytecode flag", (fixture) => { fixture.profile.kicadMcpRuntime.runtimePolicy.pythonLaunch.flags = ["-I", "-s", "-E"]; }],
      ["launch argument count drift", (fixture) => { fixture.profile.kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentCount = 4; }],
      ["launch argument digest drift", (fixture) => { fixture.profile.kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentsSha256 = "0".repeat(64); }],
      ["bytecode writes enabled", (fixture) => { fixture.profile.kicadMcpRuntime.runtimePolicy.pythonLaunch.bytecodeWrites = "enabled"; }],
      ["project cwd", (fixture) => { fixture.profile.kicadMcpRuntime.runtimePolicy.workingDirectory = "project"; }],
      ["unsafe early exit", (fixture) => { fixture.profile.kicadMcpRuntime.processTreeSupervision.earlyRootExit = "kill-by-pid"; }],
      ["unbounded connections", (fixture) => { fixture.profile.kicadMcpRuntime.connectionPolicy.maxConnections = 9; }],
      ["mutable runtime overlap", (fixture) => { fixture.profile.kicadMcpRuntime.runtimeParentRoot = fixture.environment.EVLEDA_FLUX_WORKSPACE_ROOT; }],
      ["socket overlap", (fixture) => { fixture.profile.kicadMcpRuntime.ipcSocketParentRoot = fixture.environment.EVLEDA_FLUX_WORKSPACE_ROOT; }],
    ];
    for (const [name, mutate] of cases) {
      const fixture = await createFixture("openai");
      mutate(fixture);
      await fixture.rewrite();
      let processCalls = 0;
      await expect(loadFluxProductionComposition(fixture.environment, {
        processRunner: async (options) => {
          processCalls += 1;
          return await fakeProcessRunner()(options);
        },
      }), name).rejects.toMatchObject({ reasonCode: "KICAD_MCP_RUNTIME_UNAVAILABLE" });
      expect(processCalls, name).toBe(0);
    }

    const selfReferentialManifest = await createFixture("openai");
    const nestedManifestPath = path.join(selfReferentialManifest.profile.kicadMcpRuntime.runtimeBundle.root, "manifest.json");
    const nestedManifestBytes = await readFile(selfReferentialManifest.profile.kicadMcpRuntime.runtimeBundle.manifest.path);
    await writeFile(nestedManifestPath, nestedManifestBytes);
    const nestedManifestIdentity = contentIdentity(nestedManifestBytes);
    selfReferentialManifest.profile.kicadMcpRuntime.runtimeBundle.manifest = {
      path: nestedManifestPath,
      sha256: nestedManifestIdentity.digest,
      sizeBytes: nestedManifestIdentity.size,
    };
    await selfReferentialManifest.rewrite();
    let nestedManifestProbeCalls = 0;
    await expect(loadFluxProductionComposition(selfReferentialManifest.environment, {
      processRunner: async (options) => {
        nestedManifestProbeCalls += 1;
        return await fakeProcessRunner()(options);
      },
    })).rejects.toMatchObject({ reasonCode: "KICAD_MCP_RUNTIME_UNAVAILABLE" });
    expect(nestedManifestProbeCalls).toBe(0);
  });

  it("aborts before stores for unsupported or extra-bearing profiles that also omit the toolchain", async () => {
    const unknown = await createFixture("openai");
    unknown.profile.schemaVersion = "evleda.flux-production-profile.v99";
    delete unknown.profile.kicadToolchain;
    const unknownDataDirectory = path.join(unknown.root, "unknown-schema-app-data");
    unknown.environment.EVLEDA_DATA_DIR = unknownDataDirectory;
    await unknown.rewrite();
    await expect(createLocalApiServer(unknown.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_INVALID",
    });
    await expect(access(unknownDataDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const extra = await createFixture("openai");
    delete extra.profile.kicadToolchain;
    extra.profile.unexpected = true;
    const extraDataDirectory = path.join(extra.root, "extra-missing-toolchain-app-data");
    extra.environment.EVLEDA_DATA_DIR = extraDataDirectory;
    await extra.rewrite();
    await expect(createLocalApiServer(extra.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_INVALID",
    });
    await expect(access(extraDataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces unconfirmed KiCad probe termination without mounting or automatically retrying Flux", async () => {
    const fixture = await createFixture("openai");
    const dataDirectory = path.join(fixture.root, "must-not-exist-after-kicad-probe-uncertainty");
    fixture.environment.EVLEDA_DATA_DIR = dataDirectory;
    let probes = 0;
    const { app, flux } = await createLocalApiServer(fixture.environment, {
      fluxProduction: {
        processRunner: async (options) => {
          probes += 1;
          throw new ProcessTreeTerminationUnconfirmedError(
            `private KiCad teardown at ${fixture.root}`,
            options,
            "private stdout token=secret",
            "private stderr credential=secret",
            "ProcessTimeoutError",
            "tree_death_unconfirmed",
          );
        },
      },
    });
    try {
      expect(flux).toBeUndefined();
      const first = await app.inject({ method: "GET", url: "/api/v1/flux/readiness" });
      expect(first.statusCode).toBe(200);
      expect(first.json().result).toMatchObject({
        schemaVersion: "evleda.flux-readiness.v1",
        configured: false,
        status: "setup_required",
        reasonCodes: ["KICAD_PROCESS_TERMINATION_UNCONFIRMED"],
        provider: null,
        compiler: null,
        toolchain: null,
        kicadMcpRuntime: null,
        diagnostic: {
          schemaVersion: "evleda.flux-diagnostic.v1",
          code: "TOOLCHAIN_FAILURE",
          evidenceIdentity: {
            algorithm: "sha256",
            schemaVersion: "evleda.flux-diagnostic-evidence.v1",
            canonicalizationVersion: "evleda-c14n-json-v1",
          },
        },
      });
      expect(Object.keys(first.json().result.diagnostic).sort()).toEqual([
        "code", "evidenceIdentity", "schemaVersion",
      ]);
      expect(first.body).not.toContain(fixture.root);
      expect(first.body).not.toContain("private stdout");
      expect(first.body).not.toContain("private stderr");
      expect(first.body).not.toContain("secret");
      expect(await app.inject({ method: "GET", url: "/api/v1/flux/readiness" })).toMatchObject({ statusCode: 200 });
      expect(await app.inject({ method: "GET", url: "/api/v1/flux/policy" })).toMatchObject({ statusCode: 503 });
      expect(probes).toBe(1);
      expect(flux).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it.each([
    { major: 11, patchVersion: 3, version: "11.0.3", reason: "library major" },
    { major: 10, patchVersion: 4, version: "10.0.4", reason: "supported patch" },
  ])("rejects a fully self-consistent pinned $version pair against the $reason contract", async ({ major, patchVersion, version }) => {
    const fixture = await createFixture("openai");
    for (const role of ["kicadCli", "pcbnew"] as const) {
      const bytes = syntheticKiCadPeVersion(role === "kicadCli" ? "kicad-cli" : "pcbnew", major, patchVersion);
      expect(parsePeVersionInfo(bytes)).toMatchObject({
        fileVersion: `${version}.49839`,
        productVersion: version,
      });
      await writeFile(fixture.profile.kicadToolchain[role].path, bytes);
      const identity = contentIdentity(bytes);
      fixture.profile.kicadToolchain[role].sha256 = identity.digest;
      fixture.profile.kicadToolchain[role].sizeBytes = identity.size;
      fixture.profile.kicadToolchain[role].peFileVersion = `${version}.49839`;
      fixture.profile.kicadToolchain[role].peProductVersion = version;
    }
    fixture.profile.kicadToolchain.kicadCli.operationalVersion = version;
    await fixture.rewrite();
    let probes = 0;
    await expect(loadFluxProductionComposition(fixture.environment, {
      processRunner: async (options) => { probes += 1; return await fakeProcessRunner()(options); },
    })).rejects.toMatchObject({ reasonCode: "KICAD_TOOLCHAIN_UNAVAILABLE" });
    expect(probes).toBe(0);
  });

  it("rejects pinned PE file/fixed patch 10.0.4 when operational/product remains 10.0.3", async () => {
    const fixture = await createFixture("openai");
    for (const role of ["kicadCli", "pcbnew"] as const) {
      const bytes = syntheticKiCadPeVersion(role === "kicadCli" ? "kicad-cli" : "pcbnew", 10, 4);
      const productNeedle = Buffer.from("10.0.4\0", "utf16le");
      const productOffset = bytes.lastIndexOf(productNeedle);
      expect(productOffset).toBeGreaterThanOrEqual(0);
      Buffer.from("10.0.3\0", "utf16le").copy(bytes, productOffset);
      expect(parsePeVersionInfo(bytes)).toMatchObject({
        fixedFileVersion: "10.0.4.49839",
        fixedProductVersion: "10.0.4.49839",
        fileVersion: "10.0.4.49839",
        productVersion: "10.0.3",
      });
      await writeFile(fixture.profile.kicadToolchain[role].path, bytes);
      const identity = contentIdentity(bytes);
      fixture.profile.kicadToolchain[role].sha256 = identity.digest;
      fixture.profile.kicadToolchain[role].sizeBytes = identity.size;
      fixture.profile.kicadToolchain[role].peFileVersion = "10.0.4.49839";
    }
    await fixture.rewrite();
    let probes = 0;
    await expect(loadFluxProductionComposition(fixture.environment, {
      processRunner: async (options) => { probes += 1; return await fakeProcessRunner()(options); },
    })).rejects.toMatchObject({ reasonCode: "KICAD_TOOLCHAIN_UNAVAILABLE" });
    expect(probes).toBe(0);
  });

  it("pins both KiCad executables, PE versions, same bin root, and exact environment selectors before probes", async () => {
    const mutations: Array<(fixture: TestFixture) => Promise<void> | void> = [
      (fixture) => { fixture.profile.kicadToolchain.kicadCli.sha256 = "0".repeat(64); },
      (fixture) => { fixture.profile.kicadToolchain.pcbnew.sizeBytes += 1; },
      (fixture) => { fixture.profile.kicadToolchain.kicadCli.peFileVersion = "10.0.3.1"; },
      (fixture) => { fixture.profile.kicadToolchain.pcbnew.peProductVersion = "10.0.4"; },
      async (fixture) => {
        const bytes = syntheticKiCadPe("pcbnew");
        await writeFile(fixture.profile.kicadToolchain.kicadCli.path, bytes);
        const identity = contentIdentity(bytes);
        fixture.profile.kicadToolchain.kicadCli.sha256 = identity.digest;
        fixture.profile.kicadToolchain.kicadCli.sizeBytes = identity.size;
      },
      async (fixture) => {
        const other = path.join(fixture.root, "other-bin");
        await mkdir(other);
        const editor = path.join(other, "pcbnew.exe");
        await writeFile(editor, "other pinned editor\n", "utf8");
        const identity = contentIdentity(await readFile(editor));
        fixture.profile.kicadToolchain.pcbnew.path = editor;
        fixture.profile.kicadToolchain.pcbnew.sha256 = identity.digest;
        fixture.profile.kicadToolchain.pcbnew.sizeBytes = identity.size;
        fixture.environment.EVLEDA_PCBNEW = editor;
      },
      async (fixture) => {
        const linkedBin = path.join(fixture.root, "linked-bin");
        await symlink(
          fixture.profile.kicadToolchain.binRoot,
          linkedBin,
          process.platform === "win32" ? "junction" : "dir",
        );
        fixture.profile.kicadToolchain.binRoot = linkedBin;
        fixture.profile.kicadToolchain.kicadCli.path = path.join(linkedBin, "kicad-cli.exe");
        fixture.profile.kicadToolchain.pcbnew.path = path.join(linkedBin, "pcbnew.exe");
        fixture.environment.EVLEDA_KICAD_CLI = fixture.profile.kicadToolchain.kicadCli.path;
        fixture.environment.EVLEDA_PCBNEW = fixture.profile.kicadToolchain.pcbnew.path;
      },
      (fixture) => { fixture.environment.EVLEDA_KICAD_CLI = path.join(fixture.root, "different", "kicad-cli.exe"); },
    ];
    for (const mutate of mutations) {
      const fixture = await createFixture("openai");
      await mutate(fixture);
      await fixture.rewrite();
      let probes = 0;
      await expect(loadFluxProductionComposition(fixture.environment, {
        processRunner: async (options) => { probes += 1; return await fakeProcessRunner()(options); },
      })).rejects.toMatchObject({ reasonCode: "KICAD_TOOLCHAIN_UNAVAILABLE" });
      expect(probes).toBe(0);
    }
  });

  it("runs only exact non-GUI KiCad CLI identity probes and keeps paths out of readiness", async () => {
    const fixture = await createFixture("openai");
    delete fixture.environment.EVLEDA_KICAD_CLI;
    delete fixture.environment.EVLEDA_PCBNEW;
    fixture.environment.PATH = "original-safe-path";
    const calls: Array<Readonly<{ command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>> = [];
    const composition = await loadFluxProductionComposition(fixture.environment, {
      processRunner: async (options) => {
        calls.push({ command: options.command, args: options.args, env: options.env });
        if (calls.length === 1) fixture.environment.PATH = "mutated-after-first-probe";
        return await fakeProcessRunner()(options);
      },
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["version"],
      ["version", "--format", "commit"],
    ]);
    expect(calls.every((call) => path.basename(call.command).toLocaleLowerCase("en-US") === "kicad-cli.exe")).toBe(true);
    expect(calls.map((call) => call.env.PATH)).toEqual(["original-safe-path", "original-safe-path"]);
    expect(canonicalJson(calls[0]!.env)).toBe(canonicalJson(calls[1]!.env));
    expect(calls.every((call) => !Object.keys(call.env).some((key) => /(?:key|secret|token|profile)/iu.test(key)))).toBe(true);
    expect(composition.kicadToolchain.kicadCli.operationalCommit).toBe("146a4f2a7585c65bc580427a19b6fe2ec4a3f622");
    expect(composition.readiness.toolchain?.identity).toEqual(composition.kicadToolchain.identity);
    const serialized = JSON.stringify(composition.readiness);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain("EVLEDA_KICAD_CLI");
    expect(serialized).not.toContain("EVLEDA_PCBNEW");
  });

  it.each([
    { field: "operationalVersion", value: "10.0.4" },
    { field: "operationalCommit", value: "0".repeat(40) },
  ])("rejects KiCad CLI $field drift without ever launching pcbnew", async ({ field, value }) => {
    const fixture = await createFixture("openai");
    fixture.profile.kicadToolchain.kicadCli[field] = value;
    await fixture.rewrite();
    const calls: string[] = [];
    await expect(loadFluxProductionComposition(fixture.environment, {
      processRunner: async (options) => {
        calls.push(path.basename(options.command));
        return await fakeProcessRunner()(options);
      },
    })).rejects.toMatchObject({ reasonCode: "KICAD_TOOLCHAIN_UNAVAILABLE" });
    expect(calls).not.toContain("pcbnew.exe");
  });

  it.each(["kicadCli", "pcbnew"] as const)(
    "detects pinned %s replacement during the non-GUI operational probe",
    async (target) => {
      const fixture = await createFixture("openai");
      let replaced = false;
      const targetPath = fixture.profile.kicadToolchain[target].path as string;
      await expect(loadFluxProductionComposition(fixture.environment, {
        processRunner: async (options) => {
          const result = await fakeProcessRunner()(options);
          if (!replaced && options.args.join(" ") === "version") {
            replaced = true;
            await writeFile(targetPath, `replaced ${target}\n`, "utf8");
          }
          return result;
        },
      })).rejects.toMatchObject({ reasonCode: "KICAD_TOOLCHAIN_UNAVAILABLE" });
      expect(replaced).toBe(true);
    },
  );

  it.each([
    { stdout: "10.0.3", stderr: "" },
    { stdout: "10.0.3\n", stderr: "" },
    { stdout: " 10.0.3\r\n", stderr: "" },
    { stdout: "10.0.3\r\nextra\r\n", stderr: "" },
    { stdout: "10.0.3\r\n", stderr: "warning\r\n" },
  ])("rejects non-exact KiCad operational probe transcripts %#", async ({ stdout, stderr }) => {
    const fixture = await createFixture("openai");
    await expect(loadFluxProductionComposition(fixture.environment, {
      processRunner: async (options) => {
        const result = await fakeProcessRunner()(options);
        return options.args.join(" ") === "version" ? { ...result, stdout, stderr } : result;
      },
    })).rejects.toMatchObject({ reasonCode: "KICAD_TOOLCHAIN_UNAVAILABLE" });
  });

  it("rejects missing HTTP auth and CLI executable/version/auth without exposing secrets or paths", async () => {
    const http = await createFixture("openai");
    delete http.environment.OPENAI_API_KEY;
    const httpError = await loadFluxProductionComposition(http.environment).catch((error: unknown) => error);
    expect(httpError).toMatchObject({ reasonCode: "AUTH_NOT_CONFIGURED" });
    expect(String(httpError)).not.toContain(http.root);

    const executable = await createFixture("codex");
    executable.profile.provider.executable.sha256 = "f".repeat(64);
    await executable.rewrite();
    const executableError = await loadFluxProductionComposition(executable.environment, {
      processRunner: fakeProcessRunner(),
    }).catch((error: unknown) => error);
    expect(executableError).toMatchObject({ reasonCode: "PROVIDER_EXECUTABLE_UNAVAILABLE" });
    expect(String(executableError)).not.toContain(executable.root);

    const version = await createFixture("codex");
    version.profile.provider.executable.version = "unexpected pinned version";
    await version.rewrite();
    await expect(loadFluxProductionComposition(version.environment, {
      processRunner: fakeProcessRunner(true, "different actual version"),
    })).rejects.toMatchObject({ reasonCode: "CODEX_CONFIG_INCOMPATIBLE" });

    const auth = await createFixture("claude-cli");
    const secret = "super-secret-auth-value";
    auth.environment.ANTHROPIC_API_KEY = secret;
    const authError = await loadFluxProductionComposition(auth.environment, {
      processRunner: fakeProcessRunner(false),
    }).catch((error: unknown) => error);
    expect(authError).toMatchObject({ reasonCode: "AUTH_NOT_CONFIGURED" });
    expect(String(authError)).not.toContain(secret);
    expect(String(authError)).not.toContain(auth.root);
  }, 30_000);

  it("rejects same-version Codex bytes or a model not covered by the retained capability receipt before probes", async () => {
    const differentBytes = await createFixture("codex");
    let byteMismatchProbes = 0;
    await expect(loadFluxProductionComposition(differentBytes.environment, {
      processRunner: async (options) => {
        byteMismatchProbes += 1;
        return await fakeProcessRunner()(options);
      },
    })).rejects.toMatchObject({ reasonCode: "CODEX_CONFIG_INCOMPATIBLE" });
    expect(byteMismatchProbes).toBe(0);

    const differentModel = await createFixture("codex");
    differentModel.profile.provider.model = "gpt-5.6-terra";
    await differentModel.rewrite();
    let modelMismatchProbes = 0;
    await expect(loadFluxProductionComposition(differentModel.environment, {
      ...fakeCodexCaptureIdentity(differentModel),
      processRunner: async (options) => {
        modelMismatchProbes += 1;
        return await fakeProcessRunner()(options);
      },
    })).rejects.toMatchObject({ reasonCode: "CODEX_CONFIG_INCOMPATIBLE" });
    expect(modelMismatchProbes).toBe(0);
  }, 30_000);

  it("binds Astra capture through production preflight and execution while retaining the Sol capability identity", async () => {
    const fixture = await createFixture("codex"); const calls: BoundedProcessOptions[] = [];
    const runner = fakeProcessRunner();
    const dependencies = { ...fakeCodexCaptureIdentity(fixture), temporaryDirectory: fixture.root, processRunner: async (options: BoundedProcessOptions) => { calls.push(options); return runner(options); } };
    const sol = await loadFluxProductionComposition(fixture.environment, dependencies);
    expect(sol.readiness.provider!.configurationPreflight!.capabilityProfileIdentity.digest).toBe("0a42c0d70859469434d41e2f9c72262cfaf4a1790e4a29612e5f0fd1e47892fd");
    fixture.profile.provider.model = CODEX_CLI_ASTRA_CAPTURED_MODEL; await fixture.rewrite();
    const spawned: Array<Readonly<{ args: readonly string[]; env: NodeJS.ProcessEnv }>> = [];
    const astra = await loadFluxProductionComposition(fixture.environment, { ...dependencies, cliSpawn: fakeCliSpawn(spawned) });
    expect(astra.readiness.provider).toMatchObject({ model: CODEX_CLI_ASTRA_CAPTURED_MODEL, localReadCapability: "read_only_host_files", configurationPreflight: { status: "passed", imageInspectionPolicy: "disabled_by_pinned_feature" } });
    expect(astra.readiness.provider!.configurationPreflight!.capabilityProfileIdentity).not.toEqual(sol.readiness.provider!.configurationPreflight!.capabilityProfileIdentity);
    expect(astra.readiness.provider!.configurationPreflight!.evidenceIdentity).not.toEqual(sol.readiness.provider!.configurationPreflight!.evidenceIdentity);
    expect(astra.providerProfile.model).toBe(CODEX_CLI_ASTRA_CAPTURED_MODEL);
    expect(astra.providerProfile.identity).not.toEqual(sol.providerProfile.identity);
    const preflights = calls.filter((call) => call.args[0] === "exec"); expect(preflights).toHaveLength(2);
    for (const preflight of preflights) {
      expect(preflight.args).not.toContain("--model");
      expect(preflight.args.slice(0, 1 + CODEX_CLI_ISOLATION_ARGUMENTS.length)).toEqual(["exec", ...CODEX_CLI_ISOLATION_ARGUMENTS]);
      expect(preflight).not.toHaveProperty("stdin");
    }
    const interpreted = await astra.contractInterpreter.interpretCompilation({ prompt: "Create a one-resistor closed-loop PCB candidate.", clarificationAnswers: [] });
    expect(interpreted.publicState.disposition).toBe("ready");
    expect(interpreted.publicState.interpreterReceipt).toMatchObject({ providerProfile: astra.providerProfile, providerProfileIdentity: astra.providerProfile.identity });
    expect(spawned).toHaveLength(1); const args = spawned[0]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe(CODEX_CLI_ASTRA_CAPTURED_MODEL);
    expect(args.slice(0, 1 + CODEX_CLI_ISOLATION_ARGUMENTS.length)).toEqual(["exec", ...CODEX_CLI_ISOLATION_ARGUMENTS]);
    expect(args.some((argument) => /model_provider|reasoning_effort|service_tier/u.test(argument))).toBe(false);
  }, 30_000);

  it.each(["gpt-6", "gpt-6-astra-latest", "GPT-6-ASTRA", "gpt-5.6-terra", "constructor"])("rejects uncaptured Codex model %s before children without a supported-model receipt", async (model) => {
    const fixture = await createFixture("codex"); fixture.profile.provider.model = model; await fixture.rewrite();
    let probes = 0; let modelChildren = 0; let runtimeConstruction = 0;
    const failure = await loadFluxProductionComposition(fixture.environment, {
      ...fakeCodexCaptureIdentity(fixture),
      processRunner: async (options) => { probes += 1; return fakeProcessRunner()(options); },
      cliSpawn: (command, args, options) => { modelChildren += 1; return fakeCliSpawn([])(command, args, options); },
      createKicadMcpRuntime: async () => { runtimeConstruction += 1; throw new Error("uncaptured model reached runtime construction"); },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reasonCode: "CODEX_CONFIG_INCOMPATIBLE" });
    expect((failure as FluxProductionCompositionError).evidenceIdentity).toBeUndefined();
    expect({ probes, modelChildren, runtimeConstruction }).toEqual({ probes: 0, modelChildren: 0, runtimeConstruction: 0 });
  });

  it.each(["version", "auth", "configuration"] as const)(
    "detects pinned CLI executable replacement during the startup %s probe",
    async (stage) => {
      const fixture = await createFixture("codex");
      let mutated = false;
      const base = fakeProcessRunner();
      const runner: BoundedProcessRunner = async (options) => {
        const result = await base(options);
        const isVersion = options.args.length === 1 && options.args[0] === "--version";
        const isAuth = options.args[0] === "login" || options.args[0] === "auth";
        const isConfiguration = options.args[0] === "exec";
        if (!mutated && (
          (stage === "version" && isVersion)
          || (stage === "auth" && isAuth)
          || (stage === "configuration" && isConfiguration)
        )) {
          mutated = true;
          await writeFile(fixture.profile.provider.executable.path, `replaced during ${stage} probe\n`, "utf8");
        }
        return result;
      };
      await expect(loadFluxProductionComposition(fixture.environment, {
        ...fakeCodexCaptureIdentity(fixture),
        processRunner: runner,
      })).rejects.toMatchObject({ reasonCode: "PROVIDER_EXECUTABLE_UNAVAILABLE" });
      expect(mutated).toBe(true);
    },
    30_000,
  );

  it.each([
    FLUX_PRODUCTION_INTERPRETATION_TIMEOUT_MS - 1,
    FLUX_PRODUCTION_INTERPRETATION_TIMEOUT_MS + 1,
    90_000,
  ])("rejects a profile deadline of %i before any subprocess", async (deadlineMs) => {
    const fixture = await createFixture();
    fixture.profile.provider.deadlineMs = deadlineMs;
    await fixture.rewrite();
    let processCalls = 0;
    await expect(loadFluxProductionComposition(fixture.environment, {
      processRunner: async (options) => {
        processCalls += 1;
        return await fakeProcessRunner()(options);
      },
    })).rejects.toMatchObject({ reasonCode: "PROVIDER_NOT_CONFIGURED" });
    expect(processCalls).toBe(0);
  }, 30_000);

  it("requires the exact pinned catalog identity", async () => {
    const catalogDrift = await createFixture();
    catalogDrift.profile.deepRules.catalogIdentity = {
      ...catalogDrift.profile.deepRules.catalogIdentity,
      digest: "0".repeat(64),
    };
    await catalogDrift.rewrite();
    await expect(loadFluxProductionComposition(catalogDrift.environment)).rejects.toMatchObject({
      reasonCode: "RULE_CATALOG_UNAVAILABLE",
    });
  }, 30_000);

  it("keeps Codex disabled until the exact profile acknowledges its local read capability", async () => {
    const fixture = await createFixture("codex");
    delete fixture.profile.provider.allowCodexLocalRead;
    await fixture.rewrite();
    await expect(loadFluxProductionComposition(fixture.environment)).rejects.toMatchObject({
      reasonCode: "CODEX_LOCAL_READ_ACK_REQUIRED",
    });

    fixture.environment.EVLEDA_DATA_DIR = path.join(fixture.root, "ack-required-app-data");
    let probes = 0;
    const { app, flux } = await createLocalApiServer(fixture.environment, {
      fluxProduction: {
        processRunner: async (options) => {
          probes += 1;
          return await fakeProcessRunner()(options);
        },
      },
    });
    try {
      expect(flux).toBeUndefined();
      expect(probes).toBe(0);
      const readiness = await app.inject({ method: "GET", url: "/api/v1/flux/readiness" });
      expect(readiness.statusCode).toBe(200);
      expect(readiness.json().result).toEqual({
        schemaVersion: "evleda.flux-readiness.v1",
        configured: false,
        status: "setup_required",
        reasonCodes: ["CODEX_LOCAL_READ_ACK_REQUIRED"],
        provider: null,
        compiler: null,
        toolchain: null,
        kicadMcpRuntime: null,
        diagnostic: null,
      });
      expect((await app.inject({ method: "GET", url: "/api/v1/flux/sources" })).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("preflights the exact Codex config and shallow schema before runtime construction", async () => {
    const fixture = await createFixture("codex");
    const calls: Array<Readonly<{
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
      windowsProcessTreeTermination: BoundedProcessOptions["windowsProcessTreeTermination"];
    }>> = [];
    const base = fakeProcessRunner();
    const runner: BoundedProcessRunner = async (options) => {
      calls.push({
        args: options.args,
        cwd: options.cwd,
        env: options.env,
        windowsProcessTreeTermination: options.windowsProcessTreeTermination,
      });
      if (options.args[0] === "exec") {
        expect(options.args).not.toContain("--model");
        expect(options.args).not.toContain("tools.view_image=false");
        expect(options.args).not.toContain("tools.web_search=false");
        expect(options.args.slice(0, 1 + CODEX_CLI_ISOLATION_ARGUMENTS.length)).toEqual([
          "exec",
          ...CODEX_CLI_ISOLATION_ARGUMENTS,
        ]);
        const schemaPath = options.args[options.args.indexOf("--output-schema") + 1]!;
        expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual(CODEX_CLI_TURN_ENVELOPE_JSON_SCHEMA);
        expect(options.args.at(-1)).toBe("-");
      }
      return await base(options);
    };
    const composition = await loadFluxProductionComposition(fixture.environment, {
      ...fakeCodexCaptureIdentity(fixture),
      processRunner: runner,
      cliSpawn: fakeCliSpawn([]),
      temporaryDirectory: fixture.root,
    });
    const preflight = calls.find((call) => call.args[0] === "exec");
    expect(preflight).toBeDefined();
    expect(preflight?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(preflight?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(preflight?.windowsProcessTreeTermination).toEqual({
      schemaVersion: "evleda.bounded-windows-process-tree-termination.v1",
      executablePath: fixture.profile.kicadMcpRuntime.processTreeSupervision.terminator.path,
      executableIdentity: {
        algorithm: "sha256",
        digest: fixture.profile.kicadMcpRuntime.processTreeSupervision.terminator.sha256,
        size: fixture.profile.kicadMcpRuntime.processTreeSupervision.terminator.sizeBytes,
      },
      cwd: fixture.profile.kicadMcpRuntime.runtimeBundle.root,
      env: {
        SYSTEMROOT: fixture.environment.SYSTEMROOT,
        WINDIR: fixture.environment.WINDIR,
      },
    });
    expect(preflight?.windowsProcessTreeTermination?.env).not.toHaveProperty("PATH");
    expect(preflight?.windowsProcessTreeTermination?.env).not.toHaveProperty("COMSPEC");
    expect(preflight?.windowsProcessTreeTermination?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(calls.every((call) => canonicalJson(call.windowsProcessTreeTermination)
      === canonicalJson(preflight?.windowsProcessTreeTermination))).toBe(true);
    expect(composition.readiness.provider?.configurationPreflight).toMatchObject({
      status: "passed",
      imageInspectionPolicy: "disabled_by_pinned_feature",
    });
    expect(Object.keys(composition.readiness.provider?.configurationPreflight ?? {}).sort()).toEqual([
      "capabilityProfileIdentity",
      "evidenceIdentity",
      "imageInspectionPolicy",
      "status",
    ]);
  }, 30_000);

  it("accepts only both exact pinned Codex 0.153.4 no-prompt transcripts", async () => {
    expect(FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPTS).toHaveLength(2);
    expect(FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPTS.map((entry) => entry.kind)).toEqual([
      "no_prompt",
      "reading_then_no_prompt",
    ]);
    const evidenceIdentities: string[] = [];
    for (const transcript of FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPTS) {
      expect(contentIdentity(Buffer.from(transcript.text, "utf8"))).toEqual(transcript.identity);
      const fixture = await createFixture("codex");
      const base = fakeProcessRunner();
      const composition = await loadFluxProductionComposition(fixture.environment, {
        ...fakeCodexCaptureIdentity(fixture),
        processRunner: async (options) => {
          const result = await base(options);
          return options.args[0] === "exec" ? { ...result, stderr: transcript.text } : result;
        },
        temporaryDirectory: fixture.root,
      });
      expect(composition.readiness.status).toBe("ready");
      evidenceIdentities.push(composition.readiness.provider!.configurationPreflight!.evidenceIdentity.digest);
    }
    expect(new Set(evidenceIdentities).size).toBe(2);
  }, 30_000);

  it.each([
    { label: "missing trailing LF", exitCode: 1, stdout: "", stderr: "No prompt provided via stdin." },
    { label: "leading whitespace", exitCode: 1, stdout: "", stderr: " No prompt provided via stdin.\n" },
    { label: "CRLF substitution", exitCode: 1, stdout: "", stderr: "Reading prompt from stdin...\r\nNo prompt provided via stdin.\r\n" },
    { label: "extra diagnostic output", exitCode: 1, stdout: "", stderr: "Reading prompt from stdin...\nNo prompt provided via stdin.\nextra\n" },
    { label: "configuration error", exitCode: 1, stdout: "", stderr: "unknown configuration field tools.view_image\n" },
    { label: "authentication text", exitCode: 1, stdout: "", stderr: "Not logged in\n" },
    { label: "unexpected stdout", exitCode: 1, stdout: "extra", stderr: "Reading prompt from stdin...\nNo prompt provided via stdin.\n" },
    { label: "unexpected success", exitCode: 0, stdout: "", stderr: "Reading prompt from stdin...\nNo prompt provided via stdin.\n" },
  ])("rejects Codex preflight drift: $label", async ({ exitCode, stdout, stderr }) => {
    const fixture = await createFixture("codex");
    const base = fakeProcessRunner();
    await expect(loadFluxProductionComposition(fixture.environment, {
      ...fakeCodexCaptureIdentity(fixture),
      processRunner: async (options) => options.args[0] === "exec"
        ? {
            command: options.command,
            args: options.args,
            cwd: options.cwd,
            exitCode,
            stdout,
            stderr,
            durationMs: 1,
            startedAt: "2026-09-07T00:00:00.000Z",
          }
        : await base(options),
      temporaryDirectory: fixture.root,
    })).rejects.toMatchObject({ reasonCode: "CODEX_CONFIG_INCOMPATIBLE" });
  }, 30_000);

  it.each(["schema", "output"] as const)(
    "rejects Codex preflight %s artifacts even with an exact transcript",
    async (kind) => {
      const fixture = await createFixture("codex");
      const base = fakeProcessRunner();
      await expect(loadFluxProductionComposition(fixture.environment, {
        ...fakeCodexCaptureIdentity(fixture),
        processRunner: async (options) => {
          const result = await base(options);
          if (options.args[0] === "exec") {
            const target = options.args[options.args.indexOf(kind === "schema" ? "--output-schema" : "--output-last-message") + 1]!;
            await writeFile(target, kind === "schema" ? "{}" : "unexpected", "utf8");
          }
          return result;
        },
        temporaryDirectory: fixture.root,
      })).rejects.toMatchObject({ reasonCode: "CODEX_CONFIG_INCOMPATIBLE" });
    },
    30_000,
  );

  it("returns only a stable redacted diagnostic when Codex strict config is incompatible", async () => {
    const fixture = await createFixture("codex");
    fixture.environment.EVLEDA_DATA_DIR = path.join(fixture.root, "must-not-be-created-before-preflight");
    const secret = fixture.environment.OPENAI_API_KEY!;
    const base = fakeProcessRunner();
    const runner: BoundedProcessRunner = async (options) => {
      if (options.args[0] !== "exec") return await base(options);
      return {
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        exitCode: 1,
        stdout: "",
        stderr: `error: unknown configuration field tools.view_image at ${fixture.root} token=${secret}`,
        durationMs: 1,
        startedAt: "2026-09-07T00:00:00.000Z",
      };
    };
    const { app, flux } = await createLocalApiServer(fixture.environment, {
      fluxProduction: {
        ...fakeCodexCaptureIdentity(fixture),
        processRunner: runner,
        temporaryDirectory: fixture.root,
      },
    });
    try {
      expect(flux).toBeUndefined();
      const response = await app.inject({ method: "GET", url: "/api/v1/flux/readiness" });
      expect(response.statusCode).toBe(200);
      const readiness = response.json().result as Record<string, any>;
      expect(readiness).toMatchObject({
        schemaVersion: "evleda.flux-readiness.v1",
        configured: false,
        status: "setup_required",
        reasonCodes: ["CODEX_CONFIG_INCOMPATIBLE"],
        provider: null,
        compiler: null,
        toolchain: null,
        kicadMcpRuntime: null,
        diagnostic: {
          schemaVersion: "evleda.flux-diagnostic.v1",
          code: "CODEX_CONFIG_INCOMPATIBLE",
          evidenceIdentity: {
            algorithm: "sha256",
            schemaVersion: "evleda.flux-diagnostic-evidence.v1",
            canonicalizationVersion: "evleda-c14n-json-v1",
          },
        },
      });
      expect(Object.keys(readiness.diagnostic).sort()).toEqual(["code", "evidenceIdentity", "schemaVersion"]);
      const serialized = JSON.stringify(readiness);
      expect(serialized).not.toContain(fixture.root);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("tools.view_image");
      expect((await app.inject({ method: "GET", url: "/api/v1/flux/policy" })).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("preserves safe Codex preflight failures when isolated-directory cleanup also fails", async () => {
    const fixture = await createFixture("codex");
    const base = fakeProcessRunner();
    await expect(loadFluxProductionComposition(fixture.environment, {
      ...fakeCodexCaptureIdentity(fixture),
      processRunner: async (options) => {
        if (options.args[0] !== "exec") return await base(options);
        throw new Error(`private preflight failure ${fixture.root}`);
      },
      removePreflightDirectory: async () => { throw new Error(`private cleanup failure ${fixture.root}`); },
      temporaryDirectory: fixture.root,
    })).rejects.toMatchObject({ reasonCode: "CODEX_CONFIG_INCOMPATIBLE" });

    await expect(loadFluxProductionComposition(fixture.environment, {
      ...fakeCodexCaptureIdentity(fixture),
      processRunner: base,
      removePreflightDirectory: async () => { throw new Error(`private cleanup failure ${fixture.root}`); },
      temporaryDirectory: fixture.root,
    })).rejects.toMatchObject({ reasonCode: "CODEX_CONFIG_INCOMPATIBLE" });
  }, 30_000);

  it("retains Codex preflight evidence when process-tree death is unconfirmed", async () => {
    const fixture = await createFixture("codex");
    const base = fakeProcessRunner();
    let cleanupCalls = 0;
    const { app, flux } = await createLocalApiServer(fixture.environment, {
      fluxProduction: {
        ...fakeCodexCaptureIdentity(fixture),
        processRunner: async (options) => {
          if (options.args[0] !== "exec") return await base(options);
          throw new ProcessTreeTerminationUnconfirmedError(
            "private unconfirmed teardown",
            options,
            "private stdout",
            "private stderr",
          );
        },
        removePreflightDirectory: async () => { cleanupCalls += 1; },
        temporaryDirectory: fixture.root,
      },
    });
    try {
      expect(flux).toBeUndefined();
      const response = await app.inject({ method: "GET", url: "/api/v1/flux/readiness" });
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toMatchObject({
        schemaVersion: "evleda.flux-readiness.v1",
        configured: false,
        status: "setup_required",
        reasonCodes: ["PROVIDER_PROCESS_TERMINATION_UNCONFIRMED"],
        provider: null,
        compiler: null,
        toolchain: null,
        kicadMcpRuntime: null,
        diagnostic: {
          schemaVersion: "evleda.flux-diagnostic.v1",
          code: "PROVIDER_REQUEST_FAILED",
          evidenceIdentity: {
            algorithm: "sha256",
            schemaVersion: "evleda.flux-diagnostic-evidence.v1",
            canonicalizationVersion: "evleda-c14n-json-v1",
          },
        },
      });
      expect(cleanupCalls).toBe(0);
      expect((await readdir(fixture.root)).filter((name) => name.startsWith("evleda-codex-config-preflight-"))).toHaveLength(1);
      expect(response.body).not.toContain("private unconfirmed teardown");
      expect(response.body).not.toContain("private stdout");
      expect(response.body).not.toContain(fixture.root);
    } finally {
      await app.close();
    }
  }, 30_000);

  it.each(["version", "auth"] as const)(
    "surfaces an unconfirmed provider %s probe once as static operation-uncertain readiness",
    async (probeKind) => {
      const fixture = await createFixture("codex");
      fixture.environment.EVLEDA_DATA_DIR = path.join(fixture.root, `provider-${probeKind}-application-data`);
      const privateOutput = `private ${probeKind} output ${fixture.root}`;
      const privateSecret = fixture.environment.OPENAI_API_KEY!;
      const base = fakeProcessRunner();
      let targetAttempts = 0;
      let providerCallsAfterTarget = 0;
      let targetObserved = false;
      const workspaceBefore = await readdir(fixture.environment.EVLEDA_FLUX_WORKSPACE_ROOT!);
      const { app, flux } = await createLocalApiServer(fixture.environment, {
        fluxProduction: {
          ...fakeCodexCaptureIdentity(fixture),
          processRunner: async (options) => {
            const providerCommand = samePathForTest(
              options.command,
              fixture.profile.provider.executable.path,
            );
            const target = providerCommand && (probeKind === "version"
              ? options.args.length === 1 && options.args[0] === "--version"
              : options.args[0] === "login");
            if (target) {
              targetAttempts += 1;
              targetObserved = true;
              throw new ProcessTreeTerminationUnconfirmedError(
                `${privateOutput} ${privateSecret}`,
                options,
                privateOutput,
                privateSecret,
                "ProcessTimeoutError",
                "tree_death_unconfirmed",
              );
            }
            if (providerCommand && targetObserved) providerCallsAfterTarget += 1;
            return await base(options);
          },
        },
      });
      try {
        expect(flux).toBeUndefined();
        for (let index = 0; index < 2; index += 1) {
          const response = await app.inject({ method: "GET", url: "/api/v1/flux/readiness" });
          expect(response.statusCode).toBe(200);
          expect(response.json().result).toMatchObject({
            configured: false,
            status: "setup_required",
            reasonCodes: ["PROVIDER_PROCESS_TERMINATION_UNCONFIRMED"],
            provider: null,
            compiler: null,
            toolchain: null,
            kicadMcpRuntime: null,
            diagnostic: {
              schemaVersion: "evleda.flux-diagnostic.v1",
              code: "PROVIDER_REQUEST_FAILED",
              evidenceIdentity: {
                schemaVersion: "evleda.flux-diagnostic-evidence.v1",
              },
            },
          });
          expect(response.body).not.toContain(privateOutput);
          expect(response.body).not.toContain(privateSecret);
          expect(response.body).not.toContain(fixture.root);
        }
        expect(targetAttempts).toBe(1);
        expect(providerCallsAfterTarget).toBe(0);
        expect(await readdir(fixture.environment.EVLEDA_FLUX_WORKSPACE_ROOT!))
          .toEqual(workspaceBefore);
      } finally {
        await app.close();
      }
    },
    30_000,
  );

  it.each(["codex", "claude-cli"] as const)(
    "rejects %s executable replacement after startup before the provider process is spawned",
    async (provider) => {
      const fixture = await createFixture(provider);
      const spawnCalls: Array<Readonly<{ args: readonly string[]; env: NodeJS.ProcessEnv }>> = [];
      const composition = await loadFluxProductionComposition(fixture.environment, {
        ...fakeCodexCaptureIdentity(fixture),
        processRunner: fakeProcessRunner(),
        cliSpawn: fakeCliSpawn(spawnCalls),
        temporaryDirectory: fixture.root,
      });
      await writeFile(fixture.profile.provider.executable.path, "replacement after startup\n", "utf8");
      await expect(composition.contractInterpreter.interpretCompilation({
        prompt: "This call must not reach replaced provider bytes.",
        clarificationAnswers: [],
      })).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
      expect(spawnCalls).toHaveLength(0);
    },
    30_000,
  );

  it("rejects a CLI executable inside source/workspace authority before any version or auth probe", async () => {
    const fixture = await createFixture("codex");
    const executablePath = path.join(
      fixture.environment.EVLEDA_FLUX_WORKSPACE_ROOT!,
      process.platform === "win32" ? "untrusted-provider.exe" : "untrusted-provider",
    );
    const bytes = Buffer.from("workspace-controlled provider bytes\n", "utf8");
    await writeFile(executablePath, bytes);
    const identity = contentIdentity(bytes);
    fixture.profile.provider.executable = {
      path: executablePath,
      sha256: identity.digest,
      sizeBytes: identity.size,
      version: "codex-cli 0.153.4",
    };
    await fixture.rewrite();
    let probes = 0;
    const runner: BoundedProcessRunner = async (options) => {
      probes += 1;
      return await fakeProcessRunner()(options);
    };
    await expect(loadFluxProductionComposition(fixture.environment, {
      processRunner: runner,
    })).rejects.toMatchObject({ reasonCode: "PROVIDER_EXECUTABLE_UNAVAILABLE" });
    expect(probes).toBe(0);
  }, 30_000);

  it.each([
    "gpt:C:\\private\\model.txt",
    "gpt-\\\\server\\share",
    "gpt-/private/model",
    "gpt-file:private",
    "gpt:sk-proj-secretvalue",
    "api_key-secretvalue",
  ])("rejects a non-public model identifier before it can enter readiness: %s", async (model) => {
    const fixture = await createFixture("openai");
    fixture.profile.provider.model = model;
    await fixture.rewrite();
    await expect(loadFluxProductionComposition(fixture.environment)).rejects.toMatchObject({
      reasonCode: "MODEL_NOT_CONFIGURED",
    });
  }, 30_000);

  it("preflights production before store mutation and serves only the safe readiness projection", async () => {
    const invalid = await createFixture("openai");
    const absentDataRoot = path.join(invalid.root, "must-not-be-created");
    invalid.environment.EVLEDA_DATA_DIR = absentDataRoot;
    invalid.environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.sha256] = "0".repeat(64);
    await expect(createLocalApiServer(invalid.environment)).rejects.toMatchObject({
      reasonCode: "COMPILER_PROFILE_INVALID",
    });
    await expect(access(absentDataRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const valid = await createFixture("openai");
    valid.environment.EVLEDA_DATA_DIR = path.join(valid.root, "application-data");
    const { app } = await createLocalApiServer(valid.environment, {
      fluxProduction: {
        fetch: fakeFetchFor("openai", []),
        processRunner: fakeProcessRunner(),
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/flux/readiness" });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { result: unknown };
      expect(body.result).toMatchObject({
        schemaVersion: "evleda.flux-readiness.v1",
        configured: true,
        status: "ready",
        reasonCodes: [],
        provider: { provider: "openai", requestedTier: "fast", canonicalTier: "priority" },
        compiler: { exactSymbolCount: 1, exactFootprintCount: 1 },
        kicadMcpRuntime: {
          identity: {
            algorithm: "sha256",
            schemaVersion: "evleda.kicad-mcp-runtime.v1",
            canonicalizationVersion: "evleda-c14n-json-v1",
          },
          inspectionBridgeIdentity: {
            algorithm: "sha256",
            schemaVersion: "evleda.kicad-mcp-inspection-bridge.v2",
            canonicalizationVersion: "evleda-c14n-json-v1",
          },
          executionBridgeIdentity: {
            algorithm: "sha256",
            schemaVersion: "evleda.kicad-mcp-execution-bridge.v1",
            canonicalizationVersion: "evleda-c14n-json-v1",
          },
        },
        diagnostic: null,
      });
      const serialized = JSON.stringify(body.result);
      expect(serialized).not.toContain(valid.root);
      expect(serialized).not.toContain(valid.environment.OPENAI_API_KEY!);
      expect((await app.inject({ method: "GET", url: "/api/v1/flux/readiness?path=secret" })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("blocks a nonterminal profile-A run on profile-B restart even when provider/model/tier are unchanged", async () => {
    const fixture = await createFixture("openai");
    let providerCallsA = 0;
    const compositionA = await loadFluxProductionComposition(fixture.environment, {
      fetch: async (input, init) => {
        providerCallsA += 1;
        return await fakeFetchFor("openai", [])(input, init);
      },
    });
    const runtimeA = await compositionA.createRuntime();
    const source = (await runtimeA.manager.sources()).find((entry) => entry.label === "New KiCad project")!;
    const project = await runtimeA.manager.createProject(source.key, "Profile drift candidate");
    const thread = await runtimeA.manager.createThread(project.id, "Profile A");
    const policy = runtimeA.routes.policy!();
    const run = await runtimeA.manager.createRun({
      projectId: project.id,
      threadId: thread.id,
      prompt: "Create a one-resistor closed-loop PCB candidate.",
      providerModel: policy.providerModel,
      iterationCap: 1,
      harnessRuleIdentity: policy.harnessRuleIdentity,
      mutationAllowlist: policy.mutationAllowlist,
      freshAcceptanceProfileIdentity: policy.freshAcceptanceProfileIdentity,
      freshPersistenceProfileIdentity: policy.freshPersistenceProfileIdentity,
      workflowKind: "generic",
    });
    expect((await runtimeA.manager.interpretRun(run.id)).phase).toBe("contract_ready");
    expect(providerCallsA).toBe(1);

    const profileAIdentity = compositionA.providerProfile.identity;
    const bytesA = await readFile(fixture.profilePath);
    const bytesB = Buffer.concat([bytesA, Buffer.from("\n", "utf8")]);
    await writeFile(fixture.profilePath, bytesB);
    const pinB = contentIdentity(bytesB);
    fixture.environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.sha256] = pinB.digest;
    fixture.environment[FLUX_PRODUCTION_PROFILE_ENVIRONMENT.sizeBytes] = String(pinB.size);
    let providerCallsB = 0;
    const compositionB = await loadFluxProductionComposition(fixture.environment, {
      fetch: async (input, init) => {
        providerCallsB += 1;
        return await fakeFetchFor("openai", [])(input, init);
      },
    });
    expect(compositionB.providerProfile.identity).not.toEqual(profileAIdentity);
    expect(compositionB.providerProfile.provider).toBe(compositionA.providerProfile.provider);
    expect(compositionB.providerProfile.model).toBe(compositionA.providerProfile.model);
    expect(compositionB.providerProfile.tier).toBe(compositionA.providerProfile.tier);

    const runtimeB = await compositionB.createRuntime();
    const recovered = await runtimeB.manager.getRun(run.id);
    expect(recovered.phase).toBe("blocked");
    expect(recovered.blockedReason).toMatch(/provider profile/iu);
    expect(providerCallsB).toBe(0);
    await expect(runtimeB.manager.prepareRun(run.id)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(providerCallsB).toBe(0);
  }, 30_000);

  it("uses stable redacted composition errors", () => {
    const error = new FluxProductionCompositionError("AUTH_NOT_CONFIGURED");
    expect(error.message).toBe("Flux production provider authentication is unavailable.");
    expect(error.message).not.toMatch(/key|token|path/iu);
    const toolchain = new FluxProductionCompositionError("KICAD_TOOLCHAIN_UNAVAILABLE");
    expect(toolchain.message).toBe("Pinned KiCad CLI and PCB editor toolchain identity is unavailable or incompatible.");
    expect(toolchain.message).not.toMatch(/[A-Za-z]:[\\/]|file:|sha256/iu);
  });
});

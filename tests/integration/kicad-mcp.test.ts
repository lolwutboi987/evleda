import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import livePcbPadProtocol from "../fixtures/kicad-mcp-live-pcb-pad-snapshot-protocol.json" with { type: "json" };
import schematicBatchProtocol from "../fixtures/kicad-mcp-schematic-connectivity-batch-protocol.json" with { type: "json" };
import qualifiedFootprintSyncTool from "../fixtures/kicad-mcp-qualified-footprint-sync-tool.json" with { type: "json" };
import externalPowerFlagConnectivityTool from "../fixtures/kicad-mcp-external-power-flag-connectivity-tool.json" with { type: "json" };

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as canonical from "../../src/core/canonical.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { bindKicadStartupEvidence, captureKicadStartupFailure } from "../../src/integrations/kicad-startup-diagnostic.js";
import type { BoundedProcessRunner } from "../../src/integrations/bounded-process.js";
import { resolveRuntimeCheckPaths, verifyRuntime } from "../../scripts/verify-kicad-inspection-runtime.mjs";

import {
  DEFAULT_KICAD_MCP_COMMAND,
  KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION,
  KICAD_MCP_INSPECTION_RUNTIME_MANIFEST_SCHEMA_VERSION,
  KICAD_MCP_INSPECTION_RUNTIME_TREE_SCHEMA_VERSION,
  KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
  KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
  KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
  KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  KICAD_MCP_SERVER_NAME,
  KICAD_MCP_SERVER_VERSION,
  KICAD_MCP_PRO_AUDITED_COMMIT,
  KICAD_MCP_PRO_PYPI_DISTRIBUTIONS,
  KICAD_MCP_PRO_VERSION,
  KicadMcpAuthorizationError,
  KicadMcpOutputLimitError,
  KicadMcpRuntimeVerificationDeadlineError,
  KicadMcpTerminationUncertainError,
  KicadMcpSession as RawKicadMcpSession,
  createKicadMcpInspectionBridge,
  createKicadMcpExpectedExecutableIdentity,
  parseKicadMcpInspectionRuntimeManifestSummary,
  type KicadMcpSessionOptions,
  type KicadMcpRuntimeBridgeFactoryOptions,
} from "../../src/integrations/kicad-mcp-session.js";

const FAKE_MCP_SERVER = String.raw`
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const mode = process.argv[2] ?? "single";
const liveFixturePath = mode === "live-pcb" ? process.argv[3] : undefined;
const liveFixture = liveFixturePath === undefined ? undefined : JSON.parse(require("node:fs").readFileSync(liveFixturePath, "utf8"));
let liveRead = 0;
let livePadRead = 0;
let schematicBatchCall = 0;
const tools = [
  {
    name: "kicad_get_version",
    description: "fake safe read sk-sidecar-description-secret C:/private/schema.json",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        mode: { type: "string" },
        secret: { type: ["string", "null"] },
        pathValue: { type: ["string", "null"] },
        temp: { type: ["string", "null"] },
        childPid: { type: ["number", "null"] },
        keys: { type: "array", items: { type: "string" } },
        inheritedDefaults: { type: "array", items: { type: ["string", "null"] } },
        opaque: { type: "object", additionalProperties: true }
      },
      required: ["ok", "mode", "secret", "pathValue", "temp", "childPid", "keys", "inheritedDefaults", "opaque"],
      additionalProperties: false
    }
  },
  {
    name: "sch_apply_plan",
    description: "fake reviewed write",
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" }, mode: { type: "string" } },
      required: ["ok", "mode"],
      additionalProperties: false
    }
  },
  {
    name: "export_manufacturing_package",
    description: "must never be callable",
    inputSchema: { type: "object", additionalProperties: true }
  },
  {
    name: "dfm_run_manufacturer_check",
    description: "upstream manufacturing check must also remain behind the boundary",
    inputSchema: { type: "object", additionalProperties: true }
  }
];
const projectInfoTool = {
  name: "kicad_get_project_info",
  description: "second-page safe read",
  inputSchema: { type: "object", additionalProperties: false }
};
const freshToolNames = [
  "kicad_set_project", "sch_add_symbol", "sch_modify_property", "lib_assign_footprint",
  "sch_route_wire_between_pins", "sch_add_power_symbol", "sch_move_symbol", "sch_add_label",
  "sch_add_missing_junctions", "kicad_get_project_info", "pcb_get_board_as_string"
];
const freshTools = freshToolNames.map((name) => ({
  name,
  description: "fake fresh capability " + name,
  inputSchema: { type: "object", additionalProperties: true }
}));
process.stderr.write("fake-sidecar-started:" + "x".repeat(128));
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "kicad-mcp-pro", version: "1.29.1" }
      }
    });
    return;
  }
  if (message.method === "tools/list") {
    const cursor = message.params?.cursor;
    if (liveFixture !== undefined) {
      const liveTools = [
        { name: "pcb_get_board_as_string", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        projectInfoTool,
        { name: "pcb_save", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        ...(liveFixture.advertise === false ? [] : [{ name: "evleda_get_live_pcb_document", inputSchema: { type: "object", properties: {}, additionalProperties: false } }]),
        ...(liveFixture.padTool === undefined ? [] : [liveFixture.padTool]),
        ...(liveFixture.batchTool === undefined ? [] : [liveFixture.batchTool]),
        ...(liveFixture.syncTool === undefined ? [] : [liveFixture.syncTool]),
        ...(liveFixture.graphTool === undefined ? [] : [liveFixture.graphTool]),
      ];
      send({ jsonrpc: "2.0", id: message.id, result: { tools: liveTools } });
      return;
    }
    if (mode === "deferred-workspace") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [tools[0], freshTools[0]] } });
      return;
    }
    if (["paginated", "duplicate", "conflict", "cycle"].includes(mode)) {
      if (cursor === undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [tools[0]], nextCursor: "page-2" }
        });
        return;
      }
      if (cursor === "page-2") {
        const secondTool = mode === "paginated" || mode === "cycle"
          ? projectInfoTool
          : mode === "conflict"
            ? { ...tools[0], description: "conflicting definition" }
            : tools[0];
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [secondTool],
            ...(mode === "cycle" ? { nextCursor: "page-2" } : {})
          }
        });
        return;
      }
    }
    if (mode === "fresh" || mode === "fresh-missing") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        tools: mode === "fresh-missing" ? freshTools.filter((tool) => tool.name !== "sch_add_symbol") : freshTools
      } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    if (liveFixture !== undefined) {
      require("node:fs").appendFileSync(liveFixturePath + ".calls", JSON.stringify(message.params) + "\n");
      if (message.params.name === "evleda_get_live_pcb_document") {
        const result = liveFixture.results[Math.min(liveRead++, liveFixture.results.length - 1)];
        if (result === "hang") return;
        send({ jsonrpc: "2.0", id: message.id, result });
        return;
      }
      if (message.params.name === "evleda_get_live_pcb_pad_snapshot") {
        const result = liveFixture.padResults[Math.min(livePadRead++, liveFixture.padResults.length - 1)];
        if (result === "hang") return;
        if (result === "truncated") {
          process.stdout.write('{"jsonrpc":"2.0","id":' + message.id + ',"result":{"content":[');
          return;
        }
        send({ jsonrpc: "2.0", id: message.id, result });
        return;
      }
      if (message.params.name === "sch_apply_connectivity_batch_v1") {
        const result = liveFixture.batchResults[Math.min(schematicBatchCall++, liveFixture.batchResults.length - 1)];
        if (liveFixture.batchAfterSource !== undefined) require("node:fs").writeFileSync(message.params.arguments.schematic_file, liveFixture.batchAfterSource, "utf8");
        if (liveFixture.batchProjectAfter !== undefined) require("node:fs").writeFileSync(message.params.arguments.project_file, liveFixture.batchProjectAfter, "utf8");
        if (result === "hang") return;
        if (result === "truncated") {
          process.stdout.write('{"jsonrpc":"2.0","id":' + message.id + ',"result":{"content":[');
          return;
        }
        send({ jsonrpc: "2.0", id: message.id, result });
        return;
      }
      if (message.params.name === "pcb_get_board_as_string") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: liveFixture.publicSource ?? "configured board source is not live authority" }] } });
        return;
      }
      if (message.params.name === "pcb_sync_from_schematic") {
        const payload = { result: "fake qualified footprint sync accepted" };
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: payload.result }], structuredContent: payload, isError: false } });
        return;
      }
      if (message.params.name === "sch_get_connectivity_graph") {
        const payload = { result: "Connectivity groups (1 total):\n- Group 1: VIN | pins=#FLG01:1, J1:1 | points=2" };
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: payload.result }], structuredContent: payload, isError: false } });
        return;
      }
      if (message.params.name === "kicad_get_project_info") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Project Directory: " + process.env.KICAD_MCP_PROJECT_DIR }] } });
        return;
      }
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "unexpected board action" }], isError: true } });
      return;
    }
    if (mode === "deferred-workspace" && message.params.name === "kicad_set_project") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "bound" }] } });
      return;
    }
    if (message.params.arguments?.hang === true) return;
    if (message.params.arguments?.stderrFlood === true) {
      process.stderr.write("f".repeat(512));
      return;
    }
    if (message.params.name === "kicad_get_version") {
      if (message.params.arguments?.rawSecretFailure === true) {
        send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "sk-sidecar-secret C:/private/provider-prompt.txt" }] } });
        return;
      }
      const invalid = message.params.arguments?.invalidOutput === true;
      const child = message.params.arguments?.spawnChild === true
        ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true, detached: true })
        : undefined;
      child?.unref();
      const payload = {
        ok: invalid ? "not-a-boolean" : true,
        mode: process.env.KICAD_MCP_OPERATING_MODE,
        secret: message.params.arguments?.rawSecret === true ? "sk-sidecar-secret-value" : (process.env.EVLEDA_TEST_SECRET ?? null),
        pathValue: message.params.arguments?.project_file ?? null,
        temp: process.env.TEMP ?? null,
        childPid: child?.pid ?? null,
        keys: Object.keys(process.env).sort(),
        inheritedDefaults: [process.env.PATH ?? null, process.env.USERNAME ?? null, process.env.PROGRAMFILES ?? null],
        opaque: message.params.arguments?.inspectStartup === true ? {
          workspaceSha256: require("node:crypto").createHash("sha256").update(process.env.KICAD_MCP_WORKSPACE_ROOT ?? "").digest("hex"),
          startupProjectPresent: Object.hasOwn(process.env, "KICAD_MCP_PROJECT_DIR"),
          startupOutputPresent: Object.hasOwn(process.env, "KICAD_MCP_OUTPUT_DIR")
        } : message.params.arguments?.rawSecret === true ? { "sk-secret-key-material": "opaque" } : {}
      };
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload
        }
      });
      if (message.params.arguments?.exitRootAfterResponse === true) {
        setTimeout(() => process.exit(91), 20);
      }
      return;
    }
    if (message.params.name === "sch_apply_plan") {
      const payload = { ok: true, mode: process.env.KICAD_MCP_OPERATING_MODE };
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "applied" }], structuredContent: payload }
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { isError: true, content: [{ type: "text", text: "unexpected tool" }] }
    });
  }
});
rl.on("close", () => process.exit(0));
`;

const TEST_VOLUME_ROOT = tmpdir();
let suiteRoot = "";
const ownedWorkspaces = new Set<string>();

const expectAbsent = async (candidate: string): Promise<void> => {
  try {
    await lstat(candidate);
    throw new Error("Expected removed KiCad MCP test path to be absent.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

beforeAll(async () => {
  await mkdir(TEST_VOLUME_ROOT, { recursive: true });
  suiteRoot = await mkdtemp(path.join(TEST_VOLUME_ROOT, "km-"));
  if (process.platform === "win32") {
    const relative = path.relative(path.resolve(TEST_VOLUME_ROOT), path.resolve(suiteRoot));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("KiCad MCP fake suite root escaped its captured temporary root.");
    }
  }
});

afterEach(async () => {
  const results = await Promise.allSettled([...ownedWorkspaces].map(async (workspace) => {
    await rm(workspace, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    await expectAbsent(workspace);
    ownedWorkspaces.delete(workspace);
  }));
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
});

afterAll(async () => {
  if (suiteRoot === "") return;
  await rm(suiteRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  await expectAbsent(suiteRoot);
});

async function roots(): Promise<{
  workspace: string;
  project: string;
  canonical: string;
}> {
  if (suiteRoot === "") throw new Error("KiCad MCP fake suite root is not initialized.");
  const workspace = await mkdtemp(path.join(suiteRoot, "kt-"));
  ownedWorkspaces.add(workspace);
  const project = path.join(workspace, "working-copy");
  const canonical = path.join(workspace, "canonical-source");
  await Promise.all([mkdir(project), mkdir(canonical)]);
  return { workspace, project, canonical };
}

function fakeCommand(
  mode = "single",
  bareExecutable = false,
): { command: string; args: readonly string[] } {
  return {
    command: bareExecutable ? path.basename(process.execPath) : process.execPath,
    args: [
      "-e",
      "eval(Buffer.from(process.argv[1], 'base64').toString('utf8'))",
      Buffer.from(FAKE_MCP_SERVER).toString("base64"),
      mode,
    ],
  };
}

const KicadMcpSession = {
  connect: async (options: KicadMcpSessionOptions) => {
    const command = options.command ?? fakeCommand();
    return await RawKicadMcpSession.connect({
      ...options,
      command,
      environment: options.environment ?? process.env,
      expectedLauncherIdentity: options.expectedLauncherIdentity
        ?? await createKicadMcpExpectedExecutableIdentity(command.command),
    });
  },
};

const LIVE_PCB_TOOL = "evleda_get_live_pcb_document";
const LIVE_PCB_PAD_TOOL = "evleda_get_live_pcb_pad_snapshot";
const LIVE_PCB_PAD_IDS = ["a0000000-0000-0000-0000-000000000001", "b0000000-0000-0000-0000-000000000002"] as const;
const livePcbPadTool = (): Record<string, unknown> => structuredClone({
  name: livePcbPadProtocol.toolName,
  inputSchema: livePcbPadProtocol.inputSchema,
  outputSchema: livePcbPadProtocol.outputSchema,
  annotations: livePcbPadProtocol.annotations,
});
// Transport-only fixture. Its opaque native records are intentionally not
// interpreted here; native document/electrical validation belongs to the pad decoder.
const livePcbPadPayload = (project: string, boardSource: string): Record<string, unknown> => ({
  schemaVersion: livePcbPadProtocol.schemaVersion,
  documentBefore: { project_path: project, board_filename: "active.kicad_pcb" },
  documentAfter: { project_path: project, board_filename: "active.kicad_pcb" },
  boardSourceBefore: boardSource,
  boardSourceAfter: boardSource,
  enabledCopperLayers: ["F.Cu", "B.Cu"],
  enabledLayers: { requestType: "native.request", request: {}, responseType: "native.response", response: {} },
  padRecords: [{ opaque_native_pad: { raw_value: "1234567890123456789", path: "C:/private/raw-pad", present: false } }],
  boardPadRecordIndexes: [0],
  footprintInventory: { requestType: "native.request", request: {}, responseType: "native.response", responseMetadata: {}, footprints: [] },
  padstackPresence: { requestType: "native.request", request: {}, responseType: "native.response", response: {} },
  connectivity: [],
});
const livePcbDocument = (project: string, boardSource = "(kicad_pcb (version 20260101))\n", boardFilename = "active.kicad_pcb") => ({
  schemaVersion: "evleda.kicad-live-pcb-document.v1", documentType: "pcb", projectPath: project, boardFilename, boardSource,
});
// Pinned FastMCP ToolResult wire shape: one JSON text block, the same structured root, and isError:false.
const livePcbEnvelope = (document: Record<string, unknown>): Record<string, unknown> => ({
  content: [{ type: "text", text: JSON.stringify(document) }], structuredContent: document, isError: false,
});
const livePcbFixture = async (project: string, results: readonly unknown[], options: {
  advertise?: boolean;
  publicSource?: string;
  padTool?: Readonly<Record<string, unknown>>;
  padResults?: readonly unknown[];
  batchTool?: Readonly<Record<string, unknown>>;
  batchResults?: readonly unknown[];
  batchAfterSource?: string;
  batchProjectAfter?: string;
  syncTool?: Readonly<Record<string, unknown>>;
  graphTool?: Readonly<Record<string, unknown>>;
} = {}) => {
  const fixturePath = path.join(project, "live-pcb-fixture.json");
  await writeFile(fixturePath, JSON.stringify({ results, ...options }), "utf8");
  const command = fakeCommand("live-pcb");
  return { command: { ...command, args: [...command.args, fixturePath] }, callsPath: `${fixturePath}.calls` };
};

const SCHEMATIC_BATCH_TOOL = "sch_apply_connectivity_batch_v1";
const schematicBatchTool = (): Record<string, unknown> => structuredClone({
  name: schematicBatchProtocol.toolName,
  inputSchema: schematicBatchProtocol.inputSchema,
  outputSchema: schematicBatchProtocol.outputSchema,
  annotations: schematicBatchProtocol.annotations,
});
const batchFileIdentity = (source: string) => ({ algorithm: "sha256", digest: createHash("sha256").update(source, "utf8").digest("hex"), size: Buffer.byteLength(source, "utf8") });
async function schematicBatchPlan(project: string) {
  const projectFile = path.join(project, "active.kicad_pro");
  const schematicFile = path.join(project, "active.kicad_sch");
  const before = "(kicad_sch (version 20260101))\n";
  const after = "(kicad_sch (version 20260101) (wire (pts (xy 10.16 10.16) (xy 20.32 10.16))))\n";
  await Promise.all([writeFile(projectFile, "{}\n", "utf8"), writeFile(schematicFile, before, "utf8")]);
  const args = {
    normalization_version: schematicBatchProtocol.normalizationVersion,
    project_file: projectFile, schematic_file: schematicFile,
    expected_before_sha256: batchFileIdentity(before).digest, expected_before_size_bytes: batchFileIdentity(before).size,
    wires: [{ x1_mm: 10.16, y1_mm: 10.16, x2_mm: 20.32, y2_mm: 10.16 }],
    global_labels: [{ x_mm: 10.16, y_mm: 10.16, name: "SIG", rotation: 0, shape: "passive", justify: "none" }],
    no_connects: [{ x_mm: 30.48, y_mm: 30.48 }], junctions: [] as { x_mm: number; y_mm: number }[],
  };
  // Transport-valid disk receipt only. The host consumer separately checks
  // primitive inventory, original pins, persisted source and native parity.
  const counts = { wires: 1, global_labels: 1, no_connects: 1, junctions: 0 };
  const receipt = livePcbEnvelope({
    schemaVersion: schematicBatchProtocol.schemaVersion, normalizationVersion: schematicBatchProtocol.normalizationVersion,
    applied: true, projectFile, schematicFile, before: batchFileIdentity(before), after: batchFileIdentity(after),
    submittedCounts: counts, appliedCounts: counts,
    inventory: {
      wires: [{ ...args.wires[0], uuid: "10000000-0000-0000-0000-000000000001" }],
      global_labels: [{ ...args.global_labels[0], uuid: "20000000-0000-0000-0000-000000000002" }],
      no_connects: [{ ...args.no_connects[0], uuid: "30000000-0000-0000-0000-000000000003" }], junctions: [],
    },
    operationReceipt: ["wires", "global_labels", "no_connects"].map((kind) => ({ kind, index: 0, status: "applied", resultingPrimitiveIndices: [0] })),
    reload: { status: "not_requested", confirmed: false },
  });
  return { args, receipt, before, after, projectFile, schematicFile };
}

async function writeSyntheticExecutable(filePath: string, marker: string): Promise<void> {
  await writeFile(filePath, `synthetic executable ${marker}\n`, "utf8");
  if (process.platform !== "win32") await chmod(filePath, 0o700);
}

async function lockedFile(filePath: string, coreMetadataSha256?: string) {
  const identity = contentIdentity(await readFile(filePath));
  return {
    filename: path.basename(filePath),
    sizeBytes: identity.size,
    sha256: identity.digest,
    ...(coreMetadataSha256 === undefined ? {} : { coreMetadataSha256 }),
  };
}

async function syntheticInspectionBridgeFixture(additionalRuntimeFiles = 0, scattered = false) {
  const { workspace, project } = await roots();
  const authority = await mkdtemp(path.join(suiteRoot, "ka-"));
  ownedWorkspaces.add(authority);
  const tools = path.join(authority, "tools");
  const systemRoot = path.join(authority, "windows");
  const system32 = path.join(systemRoot, "System32");
  const runtimeHome = path.join(authority, "runtime-home");
  const uvCache = path.join(authority, "uv-cache");
  const hostTemp = path.join(authority, "ipc-temp");
  const outputRoot = path.join(workspace, "inspection-output");
  await Promise.all([tools, system32, runtimeHome, uvCache, hostTemp, outputRoot].map(async (directory) => await mkdir(directory, { recursive: true })));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const uv = path.join(tools, `uv${suffix}`);
  const uvx = path.join(tools, `uvx${suffix}`);
  const python = path.join(tools, `python${suffix}`);
  const kicadCli = path.join(tools, `kicad-cli${suffix}`);
  const wheel = path.join(tools, "kicad_mcp_pro-3.33.3-py3-none-any.whl");
  await Promise.all([
    writeSyntheticExecutable(uv, "uv"),
    writeSyntheticExecutable(uvx, "uvx"),
    writeSyntheticExecutable(python, "python"),
    writeSyntheticExecutable(kicadCli, "kicad-cli"),
    writeFile(wheel, "synthetic pinned wheel\n", "utf8"),
  ]);
  const coreMetadataSha256 = "c".repeat(64);
  const [uvLock, uvxLock, pythonLock, wheelLock] = await Promise.all([
    lockedFile(uv), lockedFile(uvx), lockedFile(python), lockedFile(wheel, coreMetadataSha256),
  ]);
  const archive = (filename: string, marker: string) => ({
    assetId: 1, filename, sizeBytes: 1, sha256: marker.repeat(64), url: `https://example.invalid/${filename}`,
  });
  const publishedWheel = {
    ...wheelLock, packageType: "bdist_wheel", url: "https://example.invalid/wheel", uploadedAt: "2026-09-07T00:00:00Z",
  };
  const lock = {
    schemaVersion: 2,
    sidecar: { name: "kicad-mcp-pro", distribution: "kicad-mcp-pro", version: "3.33.3", launch: { command: "uvx", args: ["--from", "kicad-mcp-pro==3.33.3", "kicad-mcp-pro"] } },
    auditedSource: {
      repository: "https://example.invalid/source", repositoryId: "fixture", commit: KICAD_MCP_PRO_AUDITED_COMMIT,
      pyprojectVersion: "3.33.3", pythonRequires: ">=3.13", mcpDependency: "fixture", license: "MIT", copyright: "fixture",
    },
    publishedDistribution: {
      verifiedAgainst: "https://example.invalid/pypi", pypiLastSerial: 1, verifiedOn: "2026-09-07",
      files: [publishedWheel], identityCaveat: "fixture",
    },
    verifiedWindowsRuntime: {
      uv: {
        version: "0.11.31", upstreamPinSource: "fixture", repository: "https://example.invalid/uv",
        release: "https://example.invalid/uv/release", archive: archive("uv.zip", "a"),
        checksumAsset: archive("uv.zip.sha256", "b"), executables: { uv: uvLock, uvx: uvxLock },
      },
      python: {
        version: "3.13.12", upstreamPinSource: "fixture", repository: "https://example.invalid/python",
        archive: archive("python.tar.gz", "d"), executable: pythonLock,
      },
      observedPackageIdentity: {
        distribution: "kicad-mcp-pro", version: "3.33.3", wheelSha256: wheelLock.sha256,
        coreMetadataSha256, mcpServerInfo: { name: KICAD_MCP_SERVER_NAME, version: KICAD_MCP_SERVER_VERSION }, mcpServerInfoCaveat: "fixture",
      },
      defaultPaths: {
        uv, uvx, uvArchive: path.join(authority, "uv.zip"), uvChecksum: path.join(authority, "uv.zip.sha256"),
        python, pythonArchive: path.join(authority, "python.tar.gz"), wheel, uvCache, runtimeHome,
        runtimeTemp: hostTemp, runRoot: path.join(authority, "run-root"),
      },
      environmentOverrides: {
        uv: "EVLEDA_KICAD_MCP_UV", uvx: "EVLEDA_KICAD_MCP_UVX",
        python: "EVLEDA_KICAD_MCP_PYTHON", wheel: "EVLEDA_KICAD_MCP_WHEEL",
        uvCache: "EVLEDA_KICAD_MCP_UV_CACHE", runtimeHome: "EVLEDA_KICAD_MCP_HOME",
        uvArchive: "EVLEDA_KICAD_MCP_UV_ARCHIVE", uvChecksum: "EVLEDA_KICAD_MCP_UV_CHECKSUM",
        pythonArchive: "EVLEDA_KICAD_MCP_PYTHON_ARCHIVE", runtimeTemp: "EVLEDA_KICAD_MCP_TEMP",
        runRoot: "EVLEDA_KICAD_MCP_RUN_ROOT",
      },
      offlineLaunchArgs: ["--offline", "--no-config", "--python", "{python}", "--from", "{wheel}", "kicad-mcp-pro"],
    },
    controllerPolicy: {
      defaultOperatingMode: "readonly", writeModeRequiresIsolatedWorkingCopy: true,
      manufacturingAndReleaseToolsForbidden: true, environmentInheritance: "allowlist-only",
      pathConfinement: "workspace-and-project-roots", launcherResolution: "fixture", toolDiscovery: "fixture", stderrOverflow: "fatal",
    },
    notice: "../NOTICE.md",
  };
  const lockPath = path.join(tools, "kicad-mcp-pro.lock.json");
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  const bundleRoot = path.join(authority, "inspection-runtime");
  const bundleScripts = path.join(bundleRoot, "environment", "Scripts");
  await mkdir(bundleScripts, { recursive: true });
  const bundlePython = path.join(bundleScripts, process.platform === "win32" ? "python.exe" : "python");
  const bundleEntrypoint = path.join(bundleRoot, "kicad-inspection-launcher.py");
  const taskkill = path.join(bundleRoot, "process-tree-terminator.exe");
  const zeroFile = path.join(bundleRoot, "environment", "zero-data.txt");
  const additionalDirectories = scattered
    ? Array.from({ length: additionalRuntimeFiles }, (_unused, index) => path.join(bundleRoot, `runtime-directory-${index}`))
    : [];
  await Promise.all(additionalDirectories.map(async (directory) => await mkdir(directory)));
  const additionalFiles = Array.from({ length: additionalRuntimeFiles }, (_unused, index) =>
    path.join(additionalDirectories[index] ?? bundleRoot, `runtime-data-${index}.txt`));
  await Promise.all([
    writeSyntheticExecutable(bundlePython, "bundle-python"),
    writeFile(bundleEntrypoint, "# synthetic closed entrypoint\n", "utf8"),
    writeSyntheticExecutable(taskkill, "taskkill"),
    writeFile(zeroFile, "", "utf8"),
    ...additionalFiles.map(async (filePath, index) => await writeFile(filePath, `runtime data ${index}\n`, "utf8")),
  ]);
  const fileRecord = async (filePath: string) => {
    const metadata = await lstat(filePath, { bigint: true });
    const identity = contentIdentity(await readFile(filePath));
    return { path: path.relative(bundleRoot, filePath).split(path.sep).join("/"), sizeBytes: identity.size, sha256: identity.digest, mode: Number(metadata.mode & 0o777n) };
  };
  const directoryRecord = async (directory: string) => {
    const metadata = await lstat(directory, { bigint: true });
    return { path: path.relative(bundleRoot, directory).split(path.sep).join("/"), mode: Number(metadata.mode & 0o777n) };
  };
  const runtimeFiles = [bundlePython, bundleEntrypoint, taskkill, zeroFile, ...additionalFiles];
  const files = (await Promise.all(runtimeFiles.map(fileRecord))).sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  const directories = (await Promise.all([
    path.join(bundleRoot, "environment"), bundleScripts, ...additionalDirectories,
  ].map(directoryRecord))).sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  const treePayload = { directories, files };
  const treeIdentity = canonicalIdentity(treePayload, KICAD_MCP_INSPECTION_RUNTIME_TREE_SCHEMA_VERSION);
  const pythonFile = files.find((file) => file.path.endsWith("python.exe") || file.path.endsWith("/python"))!;
  const entrypointFile = files.find((file) => file.path === "kicad-inspection-launcher.py")!;
  const manifestPayload = {
    schemaVersion: KICAD_MCP_INSPECTION_RUNTIME_MANIFEST_SCHEMA_VERSION,
    classification: "pinned-local-kicad-mcp-runtime",
    platform: "win32-x64",
    distribution: { name: "kicad-mcp-pro", version: "3.33.3" },
    protocol: { serverName: KICAD_MCP_SERVER_NAME, serverVersion: KICAD_MCP_SERVER_VERSION, transport: "stdio", modes: ["readonly", "write"] },
    python: { version: "3.13.12", relativePath: pythonFile.path, contentIdentity: { algorithm: "sha256" as const, digest: pythonFile.sha256, size: pythonFile.sizeBytes } },
    entrypoint: { relativePath: entrypointFile.path, callable: "kicad_mcp.server:_run_server_from_options", contentIdentity: { algorithm: "sha256" as const, digest: entrypointFile.sha256, size: entrypointFile.sizeBytes } },
    packageMetadata: { relativePath: "environment/package.metadata", consoleEntryPointRelativePath: "environment/entry_points.txt", packages: [] },
    pthPolicy: { paths: [], siteCustomization: "forbidden", bytecode: "forbidden" },
    nativeDependencyPolicy: { systemDlls: [], images: [] },
    fileCount: files.length, directoryCount: directories.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    treeIdentity, directories, files,
  };
  const manifest = { ...manifestPayload, identity: canonicalIdentity(manifestPayload, KICAD_MCP_INSPECTION_RUNTIME_MANIFEST_SCHEMA_VERSION) };
  const manifestPath = path.join(tools, "inspection-runtime-manifest.json");
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`, "utf8");
  const expectedClosure = {
    fileCount: files.length,
    treeIdentity,
    manifestIdentity: manifest.identity,
    python: { relativePath: pythonFile.path, contentIdentity: manifest.python.contentIdentity },
    entrypoint: { relativePath: entrypointFile.path, contentIdentity: manifest.entrypoint.contentIdentity },
    protocol: {
      distribution: "kicad-mcp-pro" as const, distributionVersion: KICAD_MCP_PRO_VERSION,
      serverName: KICAD_MCP_SERVER_NAME, serverVersion: KICAD_MCP_SERVER_VERSION,
      transport: "stdio" as const, modes: ["readonly", "write"] as const,
    },
  } as const;
  const runtimeParentRoot = path.join(authority, "private-runtime-parent");
  const ipcSocketParentRoot = path.join(authority, "ipc");
  await Promise.all([mkdir(runtimeParentRoot), mkdir(ipcSocketParentRoot)]);
  return {
    workspace, project, outputRoot, authority, uv, uvx, python, wheel, kicadCli, taskkill, systemRoot, lockPath,
    runtimeHome, uvCache, hostTemp, bundleRoot, bundlePython, bundleEntrypoint, zeroFile, additionalFiles, runtimeFiles,
    runtimeParentRoot, ipcSocketParentRoot, expectedClosure,
    lockFile: { path: lockPath, contentIdentity: contentIdentity(await readFile(lockPath)) },
    manifestFile: { path: manifestPath, contentIdentity: contentIdentity(await readFile(manifestPath)) },
    kicadCliInput: { path: kicadCli, contentIdentity: contentIdentity(await readFile(kicadCli)) },
    processTreeTerminatorInput: { path: taskkill, contentIdentity: contentIdentity(await readFile(taskkill)) },
  };
}

async function connectionBudgetFixture(connectionDeadlinePolicy?: "bounded-phases-v1") {
  const fixture = await syntheticInspectionBridgeFixture(3, true);
  const state = {
    now: 1_000, phase: "setup", firstMs: 29_000, postMs: 20_000, postAdvanced: false,
    preFiles: 0, postFiles: 0,
    connectorCalls: 0, binds: 0, closes: 0, launchGuard: undefined as (() => void) | undefined,
    beforeOperation: async (_label: string): Promise<void> => undefined,
    onConnect: async (): Promise<void> => undefined,
    onBind: async (): Promise<void> => undefined,
  };
  const input: KicadMcpRuntimeBridgeFactoryOptions = {
    lockFile: fixture.lockFile,
    runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
    runtimeParentRoot: fixture.runtimeParentRoot, ipcSocketParentRoot: fixture.ipcSocketParentRoot,
    verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
    ...(connectionDeadlinePolicy === undefined ? {} : { connectionDeadlinePolicy }),
    kicadCli: fixture.kicadCliInput, protectedRoots: [fixture.workspace],
    processTreeSupervision: { strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
      terminator: fixture.processTreeTerminatorInput, timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS },
    environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
    runtimeVerificationHooksForTesting: {
      now: () => state.now,
      beforeOperation: async label => {
        if (state.phase === "post" && !state.postAdvanced && label === "KiCad MCP sidecar lock:open") {
          state.postAdvanced = true; state.now += state.postMs;
        }
        await state.beforeOperation(label);
        if (label === "KiCad MCP runtime file:open") {
          if (state.phase === "pre") state.preFiles += 1;
          if (state.phase === "post") state.postFiles += 1;
        }
      },
    },
    connectSessionForTesting: async options => {
      state.connectorCalls += 1; state.launchGuard = options.assertLaunchAuthority;
      state.now += state.firstMs;
      await state.onConnect();
      return {
        identity: fakeBoundSessionIdentity(options, 9_001),
        bindDeferredInspectionProject: async () => { state.binds += 1; await state.onBind(); state.phase = "post"; },
        close: async () => { state.closes += 1; },
      } as unknown as RawKicadMcpSession;
    },
  };
  const bridge = await createKicadMcpInspectionBridge(input);
  const runBindingIdentity = canonicalIdentity({ run: "connection-budget" }, "evleda.test-run-binding.v1");
  const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
  const authority = await bridge.bindSession({ runBindingIdentity, ipcSocket: socket, mode: "readonly",
    requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
    roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot } });
  const options = { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot,
    mode: "readonly" as const, requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort() };
  state.phase = "pre";
  return { fixture, input, bridge, runBindingIdentity, socket, authority, options, state };
}

async function runtimeSchedulerFixture(gateTarget: "files" | "directories" = "files") {
  const fixture = await syntheticInspectionBridgeFixture(8, true);
  const expectedDirectoryCount = fixture.additionalFiles.length + 2;
  const gates = Array.from({ length: 4 }, () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  });
  const state = {
    armed: false, deadlineMs: 5_000, opens: 0, reads: 0, completedReads: 0, settledReads: 0, closeHooks: 0,
    activeHandles: 0, peakHandles: 0, launches: 0, firstReadError: undefined as Error | undefined,
    directoryStarts: 0, directoryCompleted: 0, directorySettled: 0, directoryActive: 0, directoryPeak: 0,
    firstDirectoryError: undefined as Error | undefined,
  };
  const handles: { identity: string; closeCalls: number; closeSettled: boolean }[] = [];
  const expectedIdentities = (await Promise.all(fixture.runtimeFiles.map(async (filePath) => {
    const metadata = await lstat(filePath, { bigint: true });
    return `${metadata.dev}:${metadata.ino}`;
  }))).sort();
  const bridge = await createKicadMcpInspectionBridge({
    lockFile: fixture.lockFile,
    runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
    runtimeParentRoot: fixture.runtimeParentRoot,
    ipcSocketParentRoot: fixture.ipcSocketParentRoot,
    verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
    kicadCli: fixture.kicadCliInput,
    protectedRoots: [fixture.workspace],
    processTreeSupervision: {
      strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
      terminator: fixture.processTreeTerminatorInput,
      timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
    },
    environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
    runtimeVerificationHooksForTesting: {
      get deadlineMsForTesting() { return state.deadlineMs; },
      operationForTesting: async (label, operation) => {
        if (!state.armed) return await operation();
        if (label === "KiCad MCP runtime directory:mode-stat") {
          const directoryIndex = state.directoryStarts++;
          state.directoryActive += 1; state.directoryPeak = Math.max(state.directoryPeak, state.directoryActive);
          try {
            if (gateTarget === "directories") await gates[directoryIndex]?.promise;
            if (directoryIndex === 0 && state.firstDirectoryError !== undefined) throw state.firstDirectoryError;
            const result = await operation(); state.directoryCompleted += 1; return result;
          } finally { state.directoryActive -= 1; state.directorySettled += 1; }
        }
        if (label === "KiCad MCP runtime file:open") {
          if (gateTarget === "directories") expect(state.directoryCompleted).toBe(expectedDirectoryCount);
          state.opens += 1;
          const handle = await operation() as FileHandle;
          const record = { identity: "", closeCalls: 0, closeSettled: false };
          handles.push(record);
          state.activeHandles += 1;
          state.peakHandles = Math.max(state.peakHandles, state.activeHandles);
          const close = handle.close.bind(handle);
          // Observe the actual descriptor cleanup: cancellation can skip the
          // bounded :close hook after capture has already called handle.close().
          handle.close = () => {
            const firstClose = record.closeCalls === 0;
            record.closeCalls += 1;
            const closing = close();
            if (firstClose) {
              // Re-entrant stream closes may resolve before the first native
              // close; only its original promise proves descriptor cleanup.
              void closing.then(() => {
                record.closeSettled = true;
                state.activeHandles -= 1;
              }, () => undefined);
            }
            return closing;
          };
          const metadata = await handle.stat({ bigint: true });
          record.identity = `${metadata.dev}:${metadata.ino}`;
          return handle;
        }
        if (label === "KiCad MCP runtime file:stream-read") {
          const readIndex = state.reads++;
          try {
            if (gateTarget === "files") await gates[readIndex]?.promise;
            if (readIndex === 0 && state.firstReadError !== undefined) throw state.firstReadError;
            const result = await operation();
            state.completedReads += 1;
            return result;
          } finally {
            state.settledReads += 1;
          }
        }
        if (label === "KiCad MCP runtime file:close") state.closeHooks += 1;
        return await operation();
      },
    },
    connectSessionForTesting: async () => { state.launches += 1; throw new Error("must not launch"); },
  });
  return { fixture, bridge, state, handles, expectedIdentities, gates, releaseAll: () => gates.forEach((gate) => gate.release()) };
}

async function productionSizedProtectedRoots(workspace: string, count: number): Promise<string[]> {
  const roots = Array.from({ length: count }, (_unused, index) =>
    path.join(workspace, `protected-root-${String(index + 1).padStart(2, "0")}`));
  await Promise.all(roots.map(async (root) => await mkdir(root)));
  return roots;
}

async function editorAllocationFixture() {
  const fixture = await syntheticInspectionBridgeFixture();
  const bridge = await createKicadMcpInspectionBridge({
    lockFile: fixture.lockFile,
    runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
    runtimeParentRoot: fixture.runtimeParentRoot,
    ipcSocketParentRoot: fixture.ipcSocketParentRoot,
    verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
    kicadCli: fixture.kicadCliInput,
    protectedRoots: [fixture.workspace],
    processTreeSupervision: {
      strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
      terminator: fixture.processTreeTerminatorInput,
      timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
    },
    environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
  });
  const runBindingIdentity = canonicalIdentity({ run: "editor-allocation" }, "evleda.test-run-binding.v1");
  const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
  const context = await bridge.getEditorLaunchContext(socket, runBindingIdentity);
  return { ...fixture, bridge, runBindingIdentity, socket, context };
}

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

async function waitForDirectoryEntryCount(directory: string, expected: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((await readdir(directory)).length !== expected) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

async function realWindowsTreePolicy(
  options: Readonly<{
    readonly processRunnerForTesting?: BoundedProcessRunner;
    readonly beforeFinalRootProofForTesting?: () => Promise<void>;
  }> = {},
) {
  if (process.platform !== "win32") throw new Error("Windows process-tree test invoked on a non-Windows host.");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot === undefined) throw new Error("Windows system root is unavailable.");
  const helperRoot = await mkdtemp(path.join(suiteRoot, "evleda-tree-helper-"));
  ownedWorkspaces.add(helperRoot);
  const helperPath = path.join(helperRoot, "process-tree-terminator.exe");
  await copyFile(path.join(systemRoot, "System32", "taskkill.exe"), helperPath);
  const terminator = await createKicadMcpExpectedExecutableIdentity(helperPath);
  return {
    strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
    terminator,
    timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
    ...options,
  } as const;
}

const testPathIdentity = (value: string): string => createHash("sha256")
  .update("evleda.kicad-mcp-path.v1\0", "utf8")
  .update(process.platform === "win32" ? path.resolve(value).toLocaleLowerCase("en-US") : path.resolve(value), "utf8")
  .digest("hex");

const fakeBoundSessionIdentity = (options: KicadMcpSessionOptions, pid: number) => ({
  mode: options.mode,
  pid,
  sessionSemanticIdentity: canonicalIdentity({ pidFree: true, authority: options.sessionSemanticAuthorityIdentity }, "evleda.kicad-mcp-session-semantic.v1"),
  sessionReceiptIdentity: canonicalIdentity({ actual: pid }, "evleda.kicad-mcp-session-receipt.v1"),
  roots: {
    workspacePathIdentity: testPathIdentity(options.workspaceRoot),
    projectPathIdentity: testPathIdentity(options.projectRoot),
    outputPathIdentity: testPathIdentity(options.outputRoot!),
  },
  launch: {
    sessionAuthorityIdentity: options.sessionAuthorityIdentity,
    sessionSemanticAuthorityIdentity: options.sessionSemanticAuthorityIdentity,
    ipcSocketIdentity: options.ipcSocket?.identity,
    workingDirectoryPathIdentity: testPathIdentity(options.launchCwd!),
    rootProcessIncarnationIdentity: canonicalIdentity({ pid }, "evleda.kicad-mcp-root-process-incarnation.v1"),
  },
});

describe("KiCad MCP subprocess session", () => {
  it.each([null, false, 60_000, "bounded-phases-v2", {}])("rejects invalid connection deadline policy before factory I/O: %j", async policy => {
    let operations = 0;
    await expect(createKicadMcpInspectionBridge({ connectionDeadlinePolicy: policy,
      runtimeVerificationHooksForTesting: { beforeOperation: async () => { operations += 1; } },
    } as unknown as KicadMcpRuntimeBridgeFactoryOptions)).rejects.toThrow("connection deadline policy is invalid");
    expect(operations).toBe(0);
  });

  it("retains the exact legacy runtime payload and adds policy identity only on opt-in", async () => {
    const identityCalls = vi.spyOn(canonical, "canonicalIdentity");
    try {
      const probe = await connectionBudgetFixture();
      const runtimePayloads = () => identityCalls.mock.calls.filter(call => call[1] === "evleda.kicad-mcp-runtime.v1")
        .map(call => call[0] as { launch: Record<string, unknown> });
      const legacy = structuredClone(runtimePayloads()[0]!);
      expect(Object.keys(legacy.launch).sort()).toEqual(["argumentCount", "argumentsSha256", "bytecodeWrites", "environmentFiles",
        "ipcSocketPolicy", "processTreeSupervision", "projectBinding", "verificationTimeoutMs", "workingDirectory", "workspaceBinding"].sort());
      const omitted = await createKicadMcpInspectionBridge(probe.input);
      expect(omitted.identity).toEqual(probe.bridge.identity);
      const optedIn = await createKicadMcpInspectionBridge({ ...probe.input, connectionDeadlinePolicy: "bounded-phases-v1" });
      const optedPayload = runtimePayloads().at(-1)!;
      expect(optedPayload).toEqual({ ...legacy, launch: { ...legacy.launch, connectionDeadlinePolicy: "bounded-phases-v1",
        connectionDeadlineBounds: { preBindTimeoutMs: 30_000, postBindTimeoutMs: 30_000, totalAdmissionTimeoutMs: 60_000 } } });
      expect(optedIn.identity).not.toEqual(omitted.identity);
      expect(optedIn.inspectionBridgeIdentity).not.toEqual(omitted.inspectionBridgeIdentity);
      expect(optedIn.executionBridgeIdentity).not.toEqual(omitted.executionBridgeIdentity);
      expect(probe.state.connectorCalls).toBe(0);
    } finally { identityCalls.mockRestore(); }
  });

  it.each([false, true])("keeps the shared legacy budget and grants a complete post-bind pass only on opt-in: %s", async enabled => {
    const probe = await connectionBudgetFixture(enabled ? "bounded-phases-v1" : undefined);
    const connecting = probe.authority.connect(probe.options);
    if (enabled) {
      const session = await connecting;
      expect(probe.state.now).toBe(50_000);
      expect(probe.state.preFiles).toBe(probe.fixture.expectedClosure.fileCount);
      expect(probe.state.postFiles).toBe(probe.fixture.expectedClosure.fileCount);
      // The connector's retained spawn guard never acquires the post-bind budget.
      expect(probe.state.launchGuard).toThrow(KicadMcpRuntimeVerificationDeadlineError);
      probe.state.phase = "setup"; await session.close();
      expect(await readdir(probe.fixture.runtimeParentRoot)).toEqual([]);
    } else {
      const error = await connecting.catch(value => value);
      expect(captureKicadStartupFailure(error, "session-connect").failure).toMatchObject({ stage: "bridge-revalidation", cause: { category: "kicad-verification-deadline" } });
      expect(probe.state.postFiles).toBe(0);
      expect(await readdir(probe.fixture.runtimeParentRoot)).toHaveLength(1);
    }
    expect(probe.state.connectorCalls).toBe(1); expect(probe.state.binds).toBe(1); expect(probe.state.closes).toBe(1);
  });

  it("snapshots the connection policy before the first factory await and ignores later mutation", async () => {
    const probe = await connectionBudgetFixture("bounded-phases-v1");
    let reads = 0;
    Object.defineProperty(probe.input, "connectionDeadlinePolicy", { configurable: true, get: () => { reads += 1; return "bounded-phases-v1"; } });
    const building = createKicadMcpInspectionBridge(probe.input);
    Object.defineProperty(probe.input, "connectionDeadlinePolicy", { value: "invalid-later", configurable: true });
    await expect(building).resolves.toHaveProperty("identity"); expect(reads).toBe(1);
    const session = await probe.authority.connect(probe.options);
    expect(probe.state.postFiles).toBe(probe.fixture.expectedClosure.fileCount);
    probe.state.phase = "setup"; await session.close();
  });

  it.each(["post phase", "caller cap", "total cap", "final checkpoint"])("bounds opt-in post-bind admission at the %s and retains poisoned state", async boundary => {
    const probe = await connectionBudgetFixture("bounded-phases-v1");
    const operation = boundary === "caller cap" ? { deadlineAtMs: probe.state.now + 40_000 } : undefined;
    if (boundary === "post phase") probe.state.postMs = 30_000;
    if (boundary === "total cap") { probe.state.firstMs = 29_999; probe.state.postMs = 30_001; }
    if (boundary === "final checkpoint") probe.state.beforeOperation = async label => {
      if (label === "KiCad MCP authority checkpoint:before-session-return") probe.state.now = 60_000;
    };
    const error = await probe.authority.connect(probe.options, operation).catch(value => value);
    expect(captureKicadStartupFailure(error, "session-connect").failure).toMatchObject({
      stage: boundary === "final checkpoint" ? "bridge-session-identity" : "bridge-revalidation", cause: { category: "kicad-verification-deadline" } });
    expect(probe.state.connectorCalls).toBe(1); expect(probe.state.binds).toBe(1); expect(probe.state.closes).toBe(1);
    expect(await readdir(probe.fixture.runtimeParentRoot)).toHaveLength(1);
    await expect(probe.bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    await expect(probe.authority.connect(probe.options)).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(probe.state.connectorCalls).toBe(1);
  });

  it.each(["deadline", "abort"])("keeps the caller's original %s even if its context is mutated during connect", async boundary => {
    const probe = await connectionBudgetFixture("bounded-phases-v1"), controller = new AbortController();
    const operation = { deadlineAtMs: probe.state.now + (boundary === "abort" ? 60_000 : 40_000), signal: controller.signal };
    probe.state.onConnect = async () => { operation.deadlineAtMs += 60_000; operation.signal = new AbortController().signal; };
    if (boundary === "abort") probe.state.beforeOperation = async label => {
      if (probe.state.phase === "post" && label === "KiCad MCP sidecar lock:open") controller.abort();
    };
    const error = await probe.authority.connect(probe.options, operation).catch(value => value);
    expect(captureKicadStartupFailure(error, "session-connect").failure).toMatchObject({ stage: "bridge-revalidation", cause: { category: "kicad-verification-deadline" } });
    expect(probe.state.closes).toBe(1);
  });

  it("preserves the readonly convenience wrapper's shared 30-second caller cap under opt-in", async () => {
    const probe = await connectionBudgetFixture("bounded-phases-v1");
    await probe.authority.disposeUnused();
    const error = await probe.bridge.connect({ ...probe.options, ipcSocket: probe.socket, runBindingIdentity: probe.runBindingIdentity }).catch(value => value);
    expect(captureKicadStartupFailure(error, "session-connect").failure).toMatchObject({ stage: "bridge-revalidation", cause: { category: "kicad-verification-deadline" } });
    expect(probe.state.postFiles).toBe(0); expect(probe.state.closes).toBe(1);
  });

  it.each(["abort", "hang"])("bounds opt-in post-bind verification on %s without publishing a late result", async reason => {
    const probe = await connectionBudgetFixture("bounded-phases-v1"), controller = new AbortController();
    probe.state.firstMs = 0; probe.state.postMs = 0;
    Object.defineProperty(probe.input.runtimeVerificationHooksForTesting!, "deadlineMsForTesting", { value: 150 });
    let release!: () => void, hit!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { hit = resolve; });
    probe.state.beforeOperation = async label => {
      if (probe.state.phase === "post" && label === "KiCad MCP runtime:readdir") { hit(); await gate; }
    };
    let published = false;
    const outcome = probe.authority.connect(probe.options, { signal: controller.signal }).then(() => { published = true; return undefined; }, error => error);
    try {
      await reached; if (reason === "abort") controller.abort();
      const error = await outcome;
      expect(captureKicadStartupFailure(error, "session-connect").failure).toMatchObject({ stage: "bridge-revalidation", cause: { category: "kicad-verification-deadline" } });
      expect(probe.state.closes).toBe(1); expect(published).toBe(false);
      expect(await readdir(probe.fixture.runtimeParentRoot)).toHaveLength(1);
    } finally { release(); await outcome; }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(published).toBe(false); expect(probe.state.connectorCalls).toBe(1);
  });

  it("expires opt-in queue admission without bypassing the earlier socket operation or spawning later", async () => {
    const probe = await connectionBudgetFixture("bounded-phases-v1");
    let release!: () => void, hit!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { hit = resolve; });
    probe.state.beforeOperation = async label => { if (label === "KiCad MCP sidecar lock:open") { hit(); await gate; } };
    const preceding = probe.authority.disposeUnused().then(() => undefined, error => error);
    let laterSettled = false;
    let later: Promise<unknown> | undefined;
    try {
      await reached;
      await expect(probe.authority.connect(probe.options, { deadlineAtMs: probe.state.now + 150 }))
        .rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
      later = probe.authority.disposeUnused({ deadlineAtMs: probe.state.now + 2_000 })
        .then(() => undefined, error => error).finally(() => { laterSettled = true; });
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      expect(laterSettled).toBe(false); expect(probe.state.connectorCalls).toBe(0);
    } finally { release(); }
    expect(await preceding).toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(await later).toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(probe.state.connectorCalls).toBe(0); expect(probe.state.binds).toBe(0);
    expect(await readdir(probe.fixture.runtimeParentRoot)).toHaveLength(1);
  });

  it("rejects a deferred result at the first phase boundary before granting post-bind time", async () => {
    const probe = await connectionBudgetFixture("bounded-phases-v1");
    probe.state.onBind = async () => { probe.state.now += 1_000; };
    const error = await probe.authority.connect(probe.options).catch(value => value);
    expect(captureKicadStartupFailure(error, "session-connect").failure).toMatchObject({
      stage: "deferred-project-binding", cause: { category: "kicad-verification-deadline" } });
    expect(probe.state.postFiles).toBe(0); expect(probe.state.postAdvanced).toBe(false);
    expect(probe.state.closes).toBe(1); expect(await readdir(probe.fixture.runtimeParentRoot)).toHaveLength(1);
  });

  it.each(["connector", "deferred bind"])("does not renew the first phase for a held %s", async stage => {
    const probe = await connectionBudgetFixture("bounded-phases-v1");
    probe.state.firstMs = 0; probe.state.postMs = 0;
    Object.defineProperty(probe.input.runtimeVerificationHooksForTesting!, "deadlineMsForTesting", { value: 150 });
    let release!: () => void, hit!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { hit = resolve; });
    let lateSpawns = 0;
    if (stage === "connector") probe.state.onConnect = async () => { hit(); await gate; probe.state.launchGuard?.(); lateSpawns += 1; };
    else probe.state.onBind = async () => { hit(); await gate; };
    const outcome = probe.authority.connect(probe.options).then(() => undefined, error => error);
    try {
      await reached;
      const error = await outcome;
      expect(captureKicadStartupFailure(error, "session-connect").failure).toMatchObject({
        stage: stage === "connector" ? "bridge-connect" : "deferred-project-binding", cause: { category: "kicad-verification-deadline" } });
      expect(probe.state.postFiles).toBe(0);
    } finally { release(); await outcome; }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(lateSpawns).toBe(0); expect(probe.state.postFiles).toBe(0);
    expect(await readdir(probe.fixture.runtimeParentRoot)).toHaveLength(1);
  });

  it("captures the exact session output validation stage before any sidecar spawn", async () => {
    const fixture = await roots();
    const observed: string[] = [];
    const error = await RawKicadMcpSession.connect({ workspaceRoot: fixture.workspace, projectRoot: fixture.project,
      outputRoot: fixture.workspace, observeStartupStage: stage => { observed.push(stage); throw new Error("observer failure"); } }).catch(value => value);
    expect(captureKicadStartupFailure(error, "bridge-connect").failure).toMatchObject({ stage: "session-output-root" });
    expect(observed.at(-1)).toBe("session-output-root");
  });

  it.each([false, true])("retains the first bridge startup cause with cleanup failure=%s", async cleanupFails => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "startup-diagnostic", cleanupFails }, "evleda.test-run-binding.v1");
    const primary = captureKicadStartupFailure(Object.assign(new Error("sk-first-secret"), { code: -32602 }), "mcp-catalog", { category: "present", truncated: false, seenBytes: 149 });
    let cleanupStarted = false;
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot, ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS, kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace], environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      processTreeSupervision: { strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY, terminator: fixture.processTreeTerminatorInput, timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS },
      runtimeVerificationHooksForTesting: { beforeOperation: async label => {
        if (label === "KiCad MCP private runtime recursive removal") { cleanupStarted = true; if (cleanupFails) throw Object.assign(new Error("sk-cleanup-secret"), { code: "EACCES" }); }
      } },
      connectSessionForTesting: async options => {
        // The actual Windows CLI probe falls back to cwd if these declared
        // known-folder paths are absent, even when `version` exits zero.
        const env = options.environment!;
        for (const key of ["LOCALAPPDATA", "APPDATA"] as const) {
          const directory = env[key]!;
          expect((await lstat(directory)).isDirectory()).toBe(true);
          expect(await realpath(directory)).toBe(directory);
          expect(path.relative(env.USERPROFILE!, directory)).toMatch(/^AppData[\\/](Local|Roaming)$/u);
        }
        throw bindKicadStartupEvidence(new Error("sk-connector-secret"), primary);
      },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    const authority = await bridge.bindSession({ runBindingIdentity, ipcSocket: socket, mode: "readonly", requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot } });
    const error = await authority.connect({ workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot,
      mode: "readonly", requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort() }).catch(value => value);
    expect(cleanupStarted).toBe(true);
    const captured = captureKicadStartupFailure(error, "session-connect");
    expect(captured.failure).toEqual(primary.failure);
    expect(captured.cleanup).toMatchObject([{ stage: "bridge-cleanup", status: cleanupFails ? "unconfirmed" : "confirmed" }]);
    expect(JSON.stringify(error)).not.toContain("sk-");
    if (cleanupFails) { expect(error).toBeInstanceOf(KicadMcpTerminationUncertainError); expect(await readdir(fixture.runtimeParentRoot)).toHaveLength(1); }
    else { expect(await readdir(fixture.runtimeParentRoot)).toEqual([]); await bridge.releaseIpcSocket(socket, runBindingIdentity); }
  });
  it("pins the audited sidecar launch identity", () => {
    expect(DEFAULT_KICAD_MCP_COMMAND).toEqual({
      command: "uvx",
      args: ["--from", "kicad-mcp-pro==3.33.3", "kicad-mcp-pro"],
    });
    expect(KICAD_MCP_PRO_VERSION).toBe("3.33.3");
    expect(KICAD_MCP_PRO_AUDITED_COMMIT).toBe(
      "817969d7e302ad470c2cac3d7c20961419400c47",
    );
    expect(KICAD_MCP_PRO_PYPI_DISTRIBUTIONS.map((file) => file.sha256)).toEqual([
      "c26f4dc6e2360375330056864490aab96f30f1d3f1c7d51bc57e42d4f9e4c26f",
      "688e54a1f721ca0318d597564c654257dab98c06469870e8e6bb7af2612d4f76",
    ]);
  });

  it("builds a path-free profile-bound readonly inspection bridge without launching", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    let launches = 0;
    let projectBindings = 0;
    let underlyingCloses = 0;
    let captured: KicadMcpSessionOptions | undefined;
    let fakeSession: RawKicadMcpSession | undefined;
    const runBindingIdentity = canonicalIdentity({ run: "synthetic-bridge" }, "evleda.test-run-binding.v1");
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: "taskkill-tree-before-sdk-close-v1",
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: 5_000,
      },
      environment: {
        SYSTEMROOT: fixture.systemRoot,
        WINDIR: fixture.systemRoot,
        OPENAI_API_KEY: "sk-bridge-secret-must-not-bind",
        PATH: "C:\\attacker-path",
      },
      connectSessionForTesting: async (options) => {
        launches += 1;
        captured = options;
        fakeSession = {
          identity: fakeBoundSessionIdentity(options, 4242),
          bindDeferredInspectionProject: async () => { projectBindings += 1; },
          close: async () => { underlyingCloses += 1; await new Promise<void>((resolve) => setTimeout(resolve, 5)); },
        } as unknown as RawKicadMcpSession;
        return fakeSession!;
      },
    });
    expect(launches).toBe(0);
    expect(bridge.inspectionBridgeIdentity.schemaVersion).toBe(KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION);
    const publicIdentity = JSON.stringify(bridge.identity);
    for (const privateValue of [fixture.workspace, fixture.lockPath, fixture.uvx, fixture.python, fixture.wheel, fixture.kicadCli, "sk-bridge-secret", "C:\\attacker-path"]) {
      expect(publicIdentity).not.toContain(privateValue);
    }
    await expect(bridge.assertCurrent()).resolves.toBeUndefined();
    await Promise.all([
      writeFile(path.join(fixture.workspace, ".env"), "KICAD_MCP_OPERATING_MODE=manufacturing\n", "utf8"),
      writeFile(path.join(fixture.project, ".env"), "KICAD_MCP_PROFILE=experimental\n", "utf8"),
    ]);
    const ipcSocket = await bridge.allocateIpcSocket({ runBindingIdentity });
    await expect(bridge.assertIpcSocket(ipcSocket, runBindingIdentity)).resolves.toMatchObject({ remainingConnections: 8, active: false });
    await expect(bridge.assertIpcSocket(
      Object.freeze({ endpoint: ipcSocket.endpoint, identity: ipcSocket.identity }),
      runBindingIdentity,
    )).rejects.toThrow(/forged/iu);
    await expect(bridge.assertIpcSocket(
      ipcSocket,
      canonicalIdentity({ run: "other" }, "evleda.test-run-binding.v1"),
    )).rejects.toThrow(/another run/iu);
    const collisionPath = ipcSocket.endpoint.slice("ipc://".length);
    await writeFile(collisionPath, "collision", "utf8");
    await expect(bridge.assertIpcSocket(ipcSocket, runBindingIdentity)).rejects.toThrow(/collides/iu);
    await rm(collisionPath, { force: true });
    const connected = await bridge.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      ipcSocket,
      runBindingIdentity,
    });
    expect(connected).toBe(fakeSession!);
    expect(launches).toBe(1);
    expect(projectBindings).toBe(1);
    expect(captured).toMatchObject({
      mode: "readonly",
      deferProjectBinding: true,
      command: { command: await realpath(fixture.bundlePython), args: ["-I", "-s", "-E", "-B", await realpath(fixture.bundleEntrypoint)] },
      kicadCliPath: await realpath(fixture.kicadCli),
      readToolAllowlist: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      writeToolAllowlist: [],
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
    });
    expect(captured!.environment).not.toHaveProperty("PATH");
    expect(captured!.environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(captured!.environment).not.toHaveProperty("KICAD_MCP_PROJECT_DIR");
    expect(captured!.extraEnvironment).toMatchObject({
      KICAD_CONFIG_HOME: expect.stringContaining(fixture.runtimeParentRoot),
      XDG_CACHE_HOME: expect.stringContaining(fixture.runtimeParentRoot),
    });
    expect((captured as unknown as { ipcSocket: { endpoint: string } }).ipcSocket.endpoint).toBe(ipcSocket.endpoint);
    expect(captured!.launchCwd).not.toContain(fixture.workspace);
    expect(captured!.environment?.TEMP).toContain(fixture.runtimeParentRoot);
    expect(captured!.environment?.TEMP).not.toContain(fixture.ipcSocketParentRoot);
    await Promise.all([connected.close(), connected.close(), connected.close()]);
    expect(underlyingCloses).toBe(1);
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    await bridge.releaseIpcSocket(ipcSocket, runBindingIdentity);
    expect(await readdir(fixture.ipcSocketParentRoot)).toEqual([]);
  });

  it("uses four global runtime file workers across sparse directories and reads each manifest file once", async () => {
    const probe = await runtimeSchedulerFixture();
    probe.state.armed = true;
    const checking = probe.bridge.assertCurrent({ deadlineAtMs: performance.now() + 5_000 });
    // Handle rejection immediately even if a broken scheduler never reaches the barrier.
    const outcome = checking.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    try {
      expect(await waitForCondition(() => probe.state.reads === 4, 1_000)).toBe(true);
      expect(probe.state.opens).toBe(4);
      expect(probe.state.activeHandles).toBe(4);
      expect(probe.state.completedReads).toBe(0);
      // The old directory-at-a-time walk cannot fill this barrier: the root
      // contains only two files. Releasing one worker must replenish globally.
      probe.gates[0]!.release();
      expect(await waitForCondition(() => probe.state.reads > 4, 1_000)).toBe(true);
      expect(probe.state.peakHandles).toBe(4);
      probe.releaseAll();
      expect((await outcome).error).toBeUndefined();
      const expectedCount = probe.fixture.expectedClosure.fileCount;
      expect(probe.state.opens).toBe(expectedCount);
      expect(probe.state.reads).toBe(expectedCount);
      expect(probe.state.completedReads).toBe(expectedCount);
      expect(probe.handles.map((handle) => handle.identity).sort()).toEqual(probe.expectedIdentities);
      expect(probe.state.closeHooks).toBe(expectedCount);
      // Node's stream teardown can re-enter handle.close(); each distinct
      // opened descriptor must have a settled close, regardless of re-entry.
      expect(probe.handles.every((handle) => handle.closeCalls >= 1 && handle.closeSettled)).toBe(true);
      expect(probe.state.activeHandles).toBe(0);
      expect(probe.state.peakHandles).toBe(4);
      expect(probe.state.launches).toBe(0);
    } finally {
      probe.releaseAll();
      await outcome;
    }
  });

  it("validates four runtime directories concurrently before hashing every manifest file", async () => {
    const probe = await runtimeSchedulerFixture("directories"); probe.state.armed = true;
    const outcome = probe.bridge.assertCurrent().then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    try {
      expect(await waitForCondition(() => probe.state.directoryStarts === 4, 1_000)).toBe(true);
      expect(probe.state.directoryPeak).toBe(4); expect(probe.state.directoryCompleted).toBe(0); expect(probe.state.opens).toBe(0);
      probe.releaseAll(); expect((await outcome).error).toBeUndefined();
      expect(probe.state.directoryStarts).toBe(10); expect(probe.state.directoryCompleted).toBe(10);
      expect(probe.state.directorySettled).toBe(10); expect(probe.state.directoryActive).toBe(0); expect(probe.state.directoryPeak).toBe(4);
      expect(probe.state.opens).toBe(probe.fixture.expectedClosure.fileCount);
      expect(probe.state.completedReads).toBe(probe.fixture.expectedClosure.fileCount);
      expect(probe.handles.every(handle => handle.closeSettled)).toBe(true); expect(probe.state.launches).toBe(0);
    } finally { probe.releaseAll(); await outcome; }
  });

  it("preserves the first runtime directory failure and never admits file hashing", async () => {
    const probe = await runtimeSchedulerFixture("directories"); const first = new Error("first directory mode read failure");
    probe.state.firstDirectoryError = first; probe.state.armed = true; let settled = false;
    const outcome = probe.bridge.assertCurrent().then(() => ({ error: undefined }), (error: unknown) => ({ error })).finally(() => { settled = true; });
    try {
      expect(await waitForCondition(() => probe.state.directoryStarts === 4, 1_000)).toBe(true);
      probe.gates[0]!.release(); expect(await waitForCondition(() => settled, 1_000)).toBe(true);
      expect((await outcome).error).toBe(first); expect(probe.state.directoryStarts).toBe(4); expect(probe.state.opens).toBe(0);
      await expect(probe.bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
      expect(probe.state.launches).toBe(0);
    } finally {
      probe.releaseAll(); await outcome;
      expect(await waitForCondition(() => probe.state.directorySettled === 4, 1_000)).toBe(true);
    }
    expect(probe.state.directoryStarts).toBe(4); expect(probe.state.opens).toBe(0);
  });

  it.each(["external abort", "absolute deadline"] as const)("bounds four held runtime directories on %s", async cancellation => {
    const probe = await runtimeSchedulerFixture("directories"), controller = new AbortController();
    probe.state.armed = true; probe.state.deadlineMs = cancellation === "absolute deadline" ? 500 : 5_000;
    let settled = false; const started = performance.now();
    const outcome = probe.bridge.assertCurrent({ signal: controller.signal }).then(() => ({ error: undefined }), (error: unknown) => ({ error })).finally(() => { settled = true; });
    try {
      expect(await waitForCondition(() => probe.state.directoryStarts === 4, 1_000)).toBe(true);
      if (cancellation === "external abort") controller.abort();
      expect(await waitForCondition(() => settled, 1_000)).toBe(true);
      expect((await outcome).error).toMatchObject({ name: "KicadMcpRuntimeVerificationDeadlineError", reason: cancellation === "external abort" ? "aborted" : "deadline" });
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(probe.state.directoryStarts).toBe(4); expect(probe.state.opens).toBe(0); expect(probe.state.launches).toBe(0);
    } finally {
      probe.releaseAll(); await outcome;
      expect(await waitForCondition(() => probe.state.directorySettled === 4, 1_000)).toBe(true);
    }
    expect(probe.state.directoryStarts).toBe(4); expect(probe.state.opens).toBe(0);
  });

  it.each(["extra directory", "directory link"] as const)("rejects a runtime %s before any file worker starts", async kind => {
    const probe = await runtimeSchedulerFixture("directories"); probe.state.armed = true;
    const added = path.join(probe.fixture.bundleRoot, "unapproved-directory");
    if (kind === "extra directory") await mkdir(added);
    else await symlink(probe.fixture.project, added, "junction");
    try {
      await expect(probe.bridge.assertCurrent()).rejects.toThrow(kind === "extra directory" ? /extra directory/ : /link or reparse/);
      expect(probe.state.opens).toBe(0); expect(probe.state.launches).toBe(0);
    } finally { probe.releaseAll(); }
  });

  it("cancels other global runtime workers on the first stream failure without admitting queued files", async () => {
    const probe = await runtimeSchedulerFixture();
    const firstError = new Error("first runtime stream failure");
    probe.state.firstReadError = firstError;
    probe.state.armed = true;
    let settled = false;
    let lateReadsSettled = false;
    const checking = probe.bridge.assertCurrent({ deadlineAtMs: performance.now() + 5_000 });
    const outcome = checking.then(() => ({ error: undefined }), (error: unknown) => ({ error }))
      .finally(() => { settled = true; });
    try {
      expect(await waitForCondition(() => probe.state.reads === 4, 1_000)).toBe(true);
      const failedAt = performance.now();
      probe.gates[0]!.release();
      expect(await waitForCondition(() => settled, 1_000)).toBe(true);
      expect((await outcome).error).toBe(firstError);
      expect(performance.now() - failedAt).toBeLessThan(1_000);
      // The other three hook gates remain held while actual handles close.
      expect(await waitForCondition(() => probe.handles.every((handle) => handle.closeSettled), 500)).toBe(true);
      expect(probe.state.settledReads).toBe(1);
      expect(probe.state.opens).toBe(4);
      expect(probe.state.reads).toBe(4);
      expect(probe.handles).toHaveLength(4);
      expect(probe.handles.every((handle) => handle.closeCalls >= 1)).toBe(true);
      expect(probe.state.activeHandles).toBe(0);
      await expect(probe.bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
      expect(probe.state.launches).toBe(0);
    } finally {
      probe.releaseAll();
      await outcome;
      lateReadsSettled = await waitForCondition(() => probe.state.settledReads === probe.state.reads, 1_000);
    }
    expect(lateReadsSettled).toBe(true);
    expect(probe.state.opens).toBe(4);
    expect(probe.state.reads).toBe(4);
    expect(probe.state.launches).toBe(0);
  });

  it.each(["external abort", "absolute deadline"] as const)("bounds four held global runtime streams on %s without admitting queued files", async (cancellation) => {
    const probe = await runtimeSchedulerFixture();
    const controller = new AbortController();
    probe.state.armed = true;
    probe.state.deadlineMs = cancellation === "absolute deadline" ? 500 : 5_000;
    let settled = false;
    let lateReadsSettled = false;
    const started = performance.now();
    const checking = probe.bridge.assertCurrent({ signal: controller.signal, deadlineAtMs: started + probe.state.deadlineMs });
    const outcome = checking.then(() => ({ error: undefined }), (error: unknown) => ({ error }))
      .finally(() => { settled = true; });
    try {
      expect(await waitForCondition(() => probe.state.reads === 4, 1_000)).toBe(true);
      if (cancellation === "external abort") controller.abort();
      expect(await waitForCondition(() => settled, 1_000)).toBe(true);
      expect((await outcome).error).toMatchObject({
        name: "KicadMcpRuntimeVerificationDeadlineError",
        reason: cancellation === "external abort" ? "aborted" : "deadline",
      });
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(await waitForCondition(() => probe.handles.every((handle) => handle.closeSettled), 500)).toBe(true);
      expect(probe.handles).toHaveLength(4);
      expect(probe.state.opens).toBe(4);
      expect(probe.state.reads).toBe(4);
      expect(probe.state.settledReads).toBe(0);
      expect(probe.state.activeHandles).toBe(0);
      await expect(probe.bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
      expect(probe.state.launches).toBe(0);
    } finally {
      probe.releaseAll();
      await outcome;
      lateReadsSettled = await waitForCondition(() => probe.state.settledReads === probe.state.reads, 1_000);
    }
    expect(lateReadsSettled).toBe(true);
    expect(probe.state.opens).toBe(4);
    expect(probe.state.reads).toBe(4);
    expect(probe.state.launches).toBe(0);
  });

  it("rejects a same-size scattered runtime file change against the actual manifest hash", async () => {
    const probe = await runtimeSchedulerFixture();
    const changedFile = probe.fixture.additionalFiles.at(-1)!;
    const before = await readFile(changedFile);
    const changed = Buffer.from(before);
    changed[0] = changed[0]! ^ 1;
    await writeFile(changedFile, changed);
    expect((await lstat(changedFile)).size).toBe(before.length);
    await expect(probe.bridge.assertCurrent()).rejects.toThrow(/runtime file.*manifest/iu);
    await expect(probe.bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(probe.state.launches).toBe(0);
  });

  it.each([9, 32])("bounds shared abort listeners with %i protected roots and still detects directory replacement", async (rootCount) => {
    const fixture = await syntheticInspectionBridgeFixture(8);
    const protectedRoots = [fixture.workspace, ...await productionSizedProtectedRoots(fixture.workspace, rootCount - 1)];
    const controller = new AbortController();
    const checkpointAbortListener = (): void => {};
    controller.signal.addEventListener("abort", checkpointAbortListener);
    const warnings: Error[] = [];
    let peakAbortListeners = 0;
    const onWarning = (warning: Error): void => {
      if (warning.name === "MaxListenersExceededWarning" && warning.message.includes("AbortSignal")) warnings.push(warning);
    };
    process.on("warning", onWarning);
    try {
      const bridge = await createKicadMcpInspectionBridge({
        lockFile: fixture.lockFile,
        runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
        runtimeParentRoot: fixture.runtimeParentRoot,
        ipcSocketParentRoot: fixture.ipcSocketParentRoot,
        verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
        kicadCli: fixture.kicadCliInput,
        protectedRoots,
        processTreeSupervision: {
          strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
          terminator: fixture.processTreeTerminatorInput,
          timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
        },
        environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
        runtimeVerificationHooksForTesting: {
          operationForTesting: async (_label, operation) => {
            // Observe listeners after each bounded operation has attached its
            // abort handler, including operations in a concurrent batch.
            await Promise.resolve();
            peakAbortListeners = Math.max(peakAbortListeners, getEventListeners(controller.signal, "abort").length);
            return await operation();
          },
        },
      });
      const assertCurrent = () => bridge.assertCurrent({ signal: controller.signal, deadlineAtMs: performance.now() + 2_000 });
      await expect(assertCurrent()).resolves.toBeUndefined();
      expect(getEventListeners(controller.signal, "abort")).toEqual([checkpointAbortListener]);

      // Preparation adds children to the workspace after runtime binding.
      const compilation = path.join(fixture.workspace, "runs", "prepared", "compilations");
      await mkdir(compilation, { recursive: true });
      await writeFile(path.join(compilation, "candidate.kicad_pcb"), "(kicad_pcb)\n", "utf8");
      await expect(assertCurrent()).resolves.toBeUndefined();
      expect(getEventListeners(controller.signal, "abort")).toEqual([checkpointAbortListener]);

      // The final protected root must remain covered even at the maximum size.
      const finalRoot = protectedRoots.at(-1)!;
      await rename(finalRoot, `${finalRoot}-original`);
      await mkdir(finalRoot);
      await expect(assertCurrent()).rejects.toThrow(`KiCad MCP protected root ${rootCount} physical identity changed.`);
      await expect(bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(peakAbortListeners).toBeGreaterThan(0);
      expect(peakAbortListeners).toBeLessThanOrEqual(10);
      expect(getEventListeners(controller.signal, "abort")).toEqual([checkpointAbortListener]);
      expect(warnings).toEqual([]);
      expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
      expect(await readdir(fixture.ipcSocketParentRoot)).toEqual([]);
    } finally {
      process.removeListener("warning", onWarning);
      controller.signal.removeEventListener("abort", checkpointAbortListener);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("binds the Windows editor listener and API-enabled config to one owned allocation and cleans GUI-created files after exit", async () => {
    const value = await editorAllocationFixture();
    const { bridge, context, socket, runBindingIdentity } = value;
    expect(socket.endpoint).toBe(`ipc://${path.join(context.tempRoot, "kicad", "api.sock")}`);
    expect(context.endpoint).toBe(socket.endpoint);
    expect(context.configRoot).toBe(path.join(context.tempRoot, "config"));
    expect(Object.keys(socket).sort()).toEqual(["endpoint", "identity"]);
    const configPath = path.join(context.configRoot, "10.0", "kicad_common.json");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ meta: { version: 6 }, api: { enable_server: true }, do_not_show_again: { data_collection_prompt: true, update_check_prompt: true } });
    expect(JSON.parse(await readFile(path.join(context.configRoot, "10.0", "kicad.json"), "utf8"))).toEqual({ meta: { version: 0 }, system: { check_for_kicad_updates: false }, pcm: { check_for_updates: false } });
    for (const [filename, kind] of [["sym-lib-table", "sym_lib_table"], ["fp-lib-table", "fp_lib_table"], ["design-block-lib-table", "design_block_lib_table"]]) {
      expect(await readFile(path.join(context.configRoot, "10.0", filename!), "utf8")).toBe(`(${kind} (version 7))\n`);
    }
    expect(await readdir(path.join(context.tempRoot, "cache"))).toEqual([]);
    const outside = path.join(value.workspace, "outside-editor-allocation.txt");
    await writeFile(outside, "keep", "utf8");
    await context.prepareLaunch();
    await expect(context.prepareLaunch()).rejects.toThrow(/already claimed/iu);
    const instances = path.join(context.tempRoot, "org.kicad.kicad", "instances");
    await mkdir(instances, { recursive: true });
    await writeFile(path.join(instances, "instance.json"), "{}", "utf8");
    await writeFile(configPath, JSON.stringify({ meta: { version: 6 }, api: { enable_server: true }, appearance: { canvas_scale: 1 } }), "utf8");
    await expect(bridge.assertIpcSocket(socket, runBindingIdentity)).resolves.toMatchObject({ active: false });
    await expect(bridge.releaseIpcSocket(socket, runBindingIdentity)).resolves.toBe("deferred_active");
    let confirmExit!: () => void;
    const exited = new Promise<void>((resolve) => { confirmExit = resolve; });
    context.observeExit(exited);
    await expect(bridge.releaseIpcSocket(socket, runBindingIdentity)).resolves.toBe("deferred_active");
    confirmExit();
    await exited;
    await expect(bridge.releaseIpcSocket(socket, runBindingIdentity)).resolves.toBe("released");
    await expectAbsent(context.tempRoot);
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(await readdir(value.ipcSocketParentRoot)).toEqual([]);
  });

  it.each(["listener", "config-directory", "config-bytes", "library-table", "extra-config", "cache"])("rejects %s drift before claiming editor launch", async (target) => {
    const value = await editorAllocationFixture();
    if (target === "config-bytes") {
      await writeFile(path.join(value.context.configRoot, "10.0", "kicad_common.json"), JSON.stringify({ api: { enable_server: false } }), "utf8");
    } else if (target === "library-table") {
      await writeFile(path.join(value.context.configRoot, "10.0", "fp-lib-table"), "(fp_lib_table)\n", "utf8");
    } else if (target === "cache") {
      await writeFile(path.join(value.context.tempRoot, "cache", "sentry-opt-in"), "1", "utf8");
    } else if (target === "extra-config") {
      await writeFile(path.join(value.context.configRoot, "10.0", "pcbnew.json"), "{}", "utf8");
    } else {
      const original = target === "listener" ? path.join(value.context.tempRoot, "kicad") : value.context.configRoot;
      await rename(original, `${original}-original`);
      await mkdir(original);
    }
    await expect(value.context.prepareLaunch()).rejects.toThrow(/identity changed|ordinary directory|config changed|cache changed/iu);
  });

  it("retains an editor allocation containing a junction and never removes its outside target", async () => {
    const value = await editorAllocationFixture();
    const outside = path.join(value.workspace, "outside-cleanup-target");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "keep", "utf8");
    await value.context.prepareLaunch();
    const exited = Promise.resolve();
    value.context.observeExit(exited);
    await exited;
    await symlink(outside, path.join(value.context.tempRoot, "unexpected-link"), process.platform === "win32" ? "junction" : "dir");
    await expect(value.bridge.releaseIpcSocket(value.socket, value.runBindingIdentity)).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect((await lstat(value.context.tempRoot)).isDirectory()).toBe(true);
    await expect(value.bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
  });

  it("detects bridge lock/runtime drift including an A-to-B-to-A executable replacement", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: "taskkill-tree-before-sdk-close-v1",
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: 5_000,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
    });
    const parked = `${fixture.bundlePython}.parked`;
    const replacement = `${fixture.bundlePython}.replacement`;
    await writeSyntheticExecutable(replacement, "replacement");
    await rename(fixture.bundlePython, parked);
    await rename(replacement, fixture.bundlePython);
    await rename(fixture.bundlePython, replacement);
    await rename(parked, fixture.bundlePython);
    await rm(replacement, { force: true });
    await expect(bridge.assertCurrent()).rejects.toThrow(/witnesses changed/iu);
  });

  it("single-flights concurrent uncertain closes and retains the private runtime exactly once", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "concurrent-close-failure" }, "evleda.test-run-binding.v1");
    let underlyingCloses = 0;
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      connectSessionForTesting: async (options) => ({
        identity: fakeBoundSessionIdentity(options, 4_242),
        bindDeferredInspectionProject: async () => undefined,
        close: async () => {
          underlyingCloses += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          throw new KicadMcpTerminationUncertainError("categorical unconfirmed tree");
        },
      }) as unknown as RawKicadMcpSession,
    });
    const ipcSocket = await bridge.allocateIpcSocket({ runBindingIdentity });
    const session = await bridge.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      ipcSocket,
      runBindingIdentity,
    });
    const outcomes = await Promise.allSettled([session.close(), session.close(), session.close()]);
    expect(outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason instanceof KicadMcpTerminationUncertainError)).toBe(true);
    expect(underlyingCloses).toBe(1);
    expect((await readdir(fixture.runtimeParentRoot)).length).toBe(1);
    await expect(bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
  });

  it("serializes IPC release behind an in-flight authority bind", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "release-during-bind" }, "evleda.test-run-binding.v1");
    let blocking = false;
    let paused = false;
    let markReached!: () => void;
    let unblock!: () => void;
    const reached = new Promise<void>((resolve) => { markReached = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: {
        beforeOperation: async (label) => {
          if (blocking && !paused && label.endsWith(":readdir")) {
            paused = true;
            markReached();
            await gate;
          }
        },
      },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    blocking = true;
    const binding = bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    });
    await reached;
    let released = false;
    const release = bridge.releaseIpcSocket(socket, runBindingIdentity).then(() => { released = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(released).toBe(false);
    unblock();
    const authority = await binding;
    await release;
    expect(released).toBe(true);
    await expect(authority.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      mode: "readonly",
      requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort(),
    })).rejects.toThrow(/released/iu);
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    expect(await readdir(fixture.ipcSocketParentRoot)).toEqual([]);
  });

  it("serializes IPC release behind an in-flight connect and refuses release while the session is active", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "release-during-connect" }, "evleda.test-run-binding.v1");
    let markConnect!: () => void;
    let unblockConnect!: () => void;
    const connectReached = new Promise<void>((resolve) => { markConnect = resolve; });
    const connectGate = new Promise<void>((resolve) => { unblockConnect = resolve; });
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      connectSessionForTesting: async (options) => {
        markConnect();
        await connectGate;
        return {
          identity: fakeBoundSessionIdentity(options, 4_243),
          bindDeferredInspectionProject: async () => undefined,
          close: async () => undefined,
        } as unknown as RawKicadMcpSession;
      },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    const authority = await bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    });
    const connecting = authority.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      mode: "readonly",
      requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort(),
    });
    await connectReached;
    const release = bridge.releaseIpcSocket(socket, runBindingIdentity);
    unblockConnect();
    const session = await connecting;
    await expect(release).resolves.toBe("deferred_active");
    await session.close();
    await expect(bridge.releaseIpcSocket(socket, runBindingIdentity)).resolves.toBe("released");
    await expect(bridge.releaseIpcSocket(socket, runBindingIdentity)).resolves.toBe("released");
  });

  it("enforces one shared eight-connect budget across distinct read and write authorities", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "budget" }, "evleda.test-run-binding.v1");
    let launches = 0;
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      connectSessionForTesting: async (options) => {
        launches += 1;
        return {
          identity: fakeBoundSessionIdentity(options, 4_000 + launches),
          bindDeferredInspectionProject: async () => undefined,
          close: async () => undefined,
        } as unknown as RawKicadMcpSession;
      },
    });
    expect(bridge.identity.schemaVersion).toBe("evleda.kicad-mcp-runtime.v1");
    expect(bridge.inspectionBridgeIdentity.schemaVersion).toBe("evleda.kicad-mcp-inspection-bridge.v2");
    expect(bridge.executionBridgeIdentity.schemaVersion).toBe("evleda.kicad-mcp-execution-bridge.v1");
    expect(bridge.executionBridgeIdentity.digest).not.toBe(bridge.inspectionBridgeIdentity.digest);
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    const writeAuthority = await bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "write",
      requiredTools: ["kicad_set_project"],
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    });
    const readAuthority = await bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    });
    expect(writeAuthority.identity.digest).not.toBe(readAuthority.identity.digest);
    expect(writeAuthority.semanticIdentity.digest).not.toBe(readAuthority.semanticIdentity.digest);
    const substitutionAuthority = await bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    });
    const parkedProject = `${fixture.project}.parked`;
    await rename(fixture.project, parkedProject);
    await mkdir(fixture.project);
    await expect(substitutionAuthority.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      mode: "readonly",
      requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort(),
    })).rejects.toThrow(/roots changed/iu);
    await rmdir(fixture.project);
    await rename(parkedProject, fixture.project);
    await expect(bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "write",
      requiredTools: ["export_manufacturing_package"],
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    })).rejects.toThrow(/outside its closed mode policy/iu);
    const writeSession = await writeAuthority.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      mode: "write",
      freshProject: true,
      requiredTools: ["kicad_set_project"],
    });
    await writeSession.close();
    const stableReadSemantic = readAuthority.semanticIdentity;
    const readAuthorityIdentities = new Set<string>();
    const readSessionSemanticIdentities = new Set<string>();
    const readSessionReceiptIdentities = new Set<string>();
    for (let index = 0; index < 7; index += 1) {
      const currentReadAuthority = index === 0 ? readAuthority : await bridge.bindSession({
        runBindingIdentity,
        ipcSocket: socket,
        mode: "readonly",
        requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
        roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
      });
      expect(currentReadAuthority.semanticIdentity).toStrictEqual(stableReadSemantic);
      readAuthorityIdentities.add(currentReadAuthority.identity.digest);
      const readSession = await currentReadAuthority.connect({
        workspaceRoot: fixture.workspace,
        projectRoot: fixture.project,
        outputRoot: fixture.outputRoot,
        mode: "readonly",
        requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort(),
      });
      readSessionSemanticIdentities.add(readSession.identity.sessionSemanticIdentity.digest);
      readSessionReceiptIdentities.add(readSession.identity.sessionReceiptIdentity.digest);
      await readSession.close();
    }
    expect(readAuthorityIdentities.size).toBe(7);
    expect(readSessionSemanticIdentities.size).toBe(1);
    expect(readSessionReceiptIdentities.size).toBe(7);
    await expect(bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    })).rejects.toThrow(/budget|exhausted/iu);
    await expect(bridge.assertIpcSocket(socket, runBindingIdentity)).resolves.toMatchObject({ remainingConnections: 0, active: false });
    expect(launches).toBe(8);
    await bridge.releaseIpcSocket(socket, runBindingIdentity);
  });

  it("enforces the runtime-tree absolute deadline before any session connect", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    let logicalNow = 0;
    let launches = 0;
    await expect(createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: {
        now: () => logicalNow,
        beforeOperation: async (label) => { if (label.endsWith(":readdir")) logicalNow = 30_001; },
      },
      connectSessionForTesting: async () => { launches += 1; throw new Error("must not launch"); },
    })).rejects.toThrow(/deadline|ordinary directory/iu);
    expect(launches).toBe(0);
  });

  it.each([
    ["never-resolving open", "KiCad MCP sidecar lock:open"],
    ["never-resolving descriptor read", "KiCad MCP sidecar lock:descriptor-stat-before"],
    ["never-resolving stream", "KiCad MCP sidecar lock:stream-read"],
    ["never-resolving close", "KiCad MCP sidecar lock:close"],
    ["never-resolving directory check", "KiCad MCP private runtime parent:directory-stat-before"],
    ["never-resolving executable check", "KiCad CLI executable:executable-access"],
  ])("bounds %s under one assertCurrent deadline and poisons all later allocation", async (_case, targetLabel) => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: targetLabel }, "evleda.test-run-binding.v1");
    const state = { target: "", deadlineMs: 5_000, hits: 0 };
    let unblock!: () => void;
    let markHit!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const hit = new Promise<void>((resolve) => { markHit = resolve; });
    let launches = 0;
    const hooks = {
      get deadlineMsForTesting() { return state.deadlineMs; },
      operationForTesting: async (label: string, operation: () => Promise<unknown>) => {
        if (label !== state.target) return await operation();
        state.hits += 1;
        markHit();
        await gate;
        return await operation();
      },
    };
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: hooks,
      connectSessionForTesting: async () => { launches += 1; throw new Error("must not launch"); },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    state.deadlineMs = 150;
    state.target = targetLabel;
    const started = performance.now();
    const checking = bridge.assertCurrent({ deadlineAtMs: performance.now() + 150 });
    await hit;
    await expect(checking).rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(state.hits).toBe(1);
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    await expect(bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "write",
      requiredTools: ["kicad_set_project"],
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    })).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(launches).toBe(0);
    unblock();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    expect(launches).toBe(0);
  });

  it("bounds an exact post-probe outer assertCurrent hang without a late write allocation", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "post-probe-outer-assert" }, "evleda.test-run-binding.v1");
    const state = { target: "", deadlineMs: 5_000 };
    let unblock!: () => void;
    let markHit!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const hit = new Promise<void>((resolve) => { markHit = resolve; });
    let launches = 0;
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: {
        get deadlineMsForTesting() { return state.deadlineMs; },
        operationForTesting: async (label, operation) => {
          if (label !== state.target) return await operation();
          markHit();
          await gate;
          return await operation();
        },
      },
      connectSessionForTesting: async (options) => {
        launches += 1;
        return {
          identity: fakeBoundSessionIdentity(options, 5_001),
          bindDeferredInspectionProject: async () => undefined,
          close: async () => undefined,
        } as unknown as RawKicadMcpSession;
      },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    const probe = await bridge.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      ipcSocket: socket,
      runBindingIdentity,
    });
    await probe.close();
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    state.target = "KiCad MCP runtime:readdir";
    state.deadlineMs = 150;
    const outerAssert = bridge.assertCurrent({ deadlineAtMs: performance.now() + 150 });
    await hit;
    await expect(outerAssert).rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
    await expect(bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "write",
      requiredTools: ["kicad_set_project"],
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    })).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(launches).toBe(1);
    unblock();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    expect(launches).toBe(1);
  });

  it("bounds a per-socket operation-tail wait and prevents the earlier bind from allocating after poison", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "operation-tail-deadline" }, "evleda.test-run-binding.v1");
    const state = { target: "", deadlineMs: 5_000 };
    let unblock!: () => void;
    let markHit!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const hit = new Promise<void>((resolve) => { markHit = resolve; });
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: {
        get deadlineMsForTesting() { return state.deadlineMs; },
        operationForTesting: async (label, operation) => {
          if (label !== state.target) return await operation();
          markHit();
          await gate;
          return await operation();
        },
      },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    state.target = "KiCad MCP sidecar lock:open";
    const first = bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    }, { deadlineAtMs: performance.now() + 3_000 });
    void first.catch(() => undefined);
    await hit;
    state.deadlineMs = 150;
    await expect(bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    }, { deadlineAtMs: performance.now() + 150 })).rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    state.deadlineMs = 2_000;
    let thirdSettled = false;
    const third = bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    }, { deadlineAtMs: performance.now() + 2_000 }).finally(() => { thirdSettled = true; });
    void third.catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(thirdSettled).toBe(false);
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    unblock();
    await expect(first).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    await expect(third).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    await expect(bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
  });

  it.each([
    ["removes an exact empty late allocation", false],
    ["retains a non-empty late allocation as uncertain evidence", true],
  ])("%s when IPC mkdtemp resolves after its caller's deadline", async (_case, contaminate) => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: `late-ipc-${contaminate}` }, "evleda.test-run-binding.v1");
    const state = { target: "", deadlineMs: 5_000 };
    let unblock!: () => void;
    let markHit!: () => void;
    let markLate!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const hit = new Promise<void>((resolve) => { markHit = resolve; });
    const lateResolved = new Promise<void>((resolve) => { markLate = resolve; });
    let latePath = "";
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: {
        get deadlineMsForTesting() { return state.deadlineMs; },
        operationForTesting: async (label, operation) => {
          if (label !== state.target) return await operation();
          markHit();
          await gate;
          const result = await operation();
          latePath = String(result);
          if (contaminate) await writeFile(path.join(latePath, "retained-evidence"), "uncertain", "utf8");
          markLate();
          return result;
        },
      },
    });
    state.target = "KiCad MCP IPC socket allocation mkdtemp";
    state.deadlineMs = 150;
    const allocating = bridge.allocateIpcSocket(
      { runBindingIdentity },
      { deadlineAtMs: performance.now() + 150 },
    );
    await hit;
    await expect(allocating).rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
    expect(await readdir(fixture.ipcSocketParentRoot)).toEqual([]);
    unblock();
    await lateResolved;
    expect(path.dirname(latePath)).toBe(await realpath(fixture.ipcSocketParentRoot));
    expect(path.basename(latePath)).toMatch(/^e-/u);
    expect(await waitForDirectoryEntryCount(fixture.ipcSocketParentRoot, contaminate ? 1 : 0)).toBe(true);
    if (contaminate) {
      expect(await readdir(latePath)).toEqual(["retained-evidence"]);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(await readdir(latePath)).toEqual(["retained-evidence"]);
    } else {
      await expectAbsent(latePath);
    }
    await expect(bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
  });

  it.each([
    ["removes an exact empty late runtime", false],
    ["retains a non-empty late runtime as uncertain evidence", true],
  ])("%s when session mkdtemp resolves after its caller's deadline", async (_case, contaminate) => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: `late-session-runtime-${contaminate}` }, "evleda.test-run-binding.v1");
    const state = { target: "", deadlineMs: 5_000 };
    let unblock!: () => void;
    let markHit!: () => void;
    let markLate!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const hit = new Promise<void>((resolve) => { markHit = resolve; });
    const lateResolved = new Promise<void>((resolve) => { markLate = resolve; });
    let latePath = "";
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: {
        get deadlineMsForTesting() { return state.deadlineMs; },
        operationForTesting: async (label, operation) => {
          if (label !== state.target) return await operation();
          markHit();
          await gate;
          const result = await operation();
          latePath = String(result);
          if (contaminate) await writeFile(path.join(latePath, "retained-evidence"), "uncertain", "utf8");
          markLate();
          return result;
        },
      },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    state.target = "KiCad MCP session runtime mkdtemp";
    state.deadlineMs = 150;
    const binding = bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    }, { deadlineAtMs: performance.now() + 150 });
    void binding.catch(() => undefined);
    await hit;
    await expect(binding).rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    unblock();
    await lateResolved;
    expect(path.dirname(latePath)).toBe(await realpath(fixture.runtimeParentRoot));
    expect(path.basename(latePath)).toMatch(/^evleda-kicad-inspection-/u);
    expect(await waitForDirectoryEntryCount(fixture.runtimeParentRoot, contaminate ? 1 : 0)).toBe(true);
    if (contaminate) {
      expect(await readdir(latePath)).toEqual(["retained-evidence"]);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(await readdir(latePath)).toEqual(["retained-evidence"]);
    } else {
      await expectAbsent(latePath);
    }
    await expect(bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
  });

  it.each([
    ["before-session-runtime-allocation"],
    ["before-session-authority-return"],
  ])("does not publish a bound authority when poison lands at %s", async (checkpoint) => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: `bind-race-${checkpoint}` }, "evleda.test-run-binding.v1");
    const state = { target: "", deadlineMs: 5_000 };
    let unblock!: () => void;
    let markHit!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const hit = new Promise<void>((resolve) => { markHit = resolve; });
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: {
        get deadlineMsForTesting() { return state.deadlineMs; },
        operationForTesting: async (label, operation) => {
          if (label !== state.target) return await operation();
          markHit();
          await gate;
          return await operation();
        },
      },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    state.target = `KiCad MCP authority checkpoint:${checkpoint}`;
    const binding = bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    }, { deadlineAtMs: performance.now() + 2_000 });
    void binding.catch(() => undefined);
    await hit;
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.assertCurrent({ signal: controller.signal })).rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
    unblock();
    await expect(binding).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(await waitForDirectoryEntryCount(fixture.runtimeParentRoot, 0)).toBe(true);
    await expect(bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
  });

  it("rechecks shared poison after connect validation and before consuming or invoking the session connector", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "pre-connect-mutation-race" }, "evleda.test-run-binding.v1");
    const state = { target: "", deadlineMs: 5_000 };
    let unblock!: () => void;
    let markHit!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const hit = new Promise<void>((resolve) => { markHit = resolve; });
    let connectorCalls = 0;
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: {
        get deadlineMsForTesting() { return state.deadlineMs; },
        operationForTesting: async (label, operation) => {
          if (label !== state.target) return await operation();
          markHit();
          await gate;
          return await operation();
        },
      },
      connectSessionForTesting: async () => {
        connectorCalls += 1;
        throw new Error("connector must not be invoked");
      },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    const authority = await bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    });
    expect((await readdir(fixture.runtimeParentRoot)).length).toBe(1);
    state.target = "KiCad MCP authority checkpoint:before-session-state-and-connect";
    const connecting = authority.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      mode: "readonly",
      requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort(),
    }, { deadlineAtMs: performance.now() + 2_000 });
    void connecting.catch(() => undefined);
    await hit;
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.assertCurrent({ signal: controller.signal })).rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
    unblock();
    await expect(connecting).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(connectorCalls).toBe(0);
    expect((await readdir(fixture.runtimeParentRoot)).length).toBe(1);
  });

  it("rechecks shared poison inside the connector immediately before transport spawn", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "pre-spawn-race" }, "evleda.test-run-binding.v1");
    let unblock!: () => void;
    let markHit!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const hit = new Promise<void>((resolve) => { markHit = resolve; });
    let connectorCalls = 0;
    let launches = 0;
    let projectBindings = 0;
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      connectSessionForTesting: async (options) => {
        connectorCalls += 1;
        markHit();
        await gate;
        options.assertLaunchAuthority?.();
        launches += 1;
        return {
          identity: fakeBoundSessionIdentity(options, 6_001),
          bindDeferredInspectionProject: async () => { projectBindings += 1; },
          close: async () => undefined,
        } as unknown as RawKicadMcpSession;
      },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    const authority = await bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    });
    const connecting = authority.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      mode: "readonly",
      requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort(),
    });
    void connecting.catch(() => undefined);
    await hit;
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.assertCurrent({ signal: controller.signal })).rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
    unblock();
    await expect(connecting).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(connectorCalls).toBe(1);
    expect(launches).toBe(0);
    expect(projectBindings).toBe(0);
    expect((await readdir(fixture.runtimeParentRoot)).length).toBe(1);
  });

  it.each([
    ["before-bound-project-bind", 0],
    ["before-session-return", 1],
  ])("does not publish a session when poison lands at %s", async (checkpoint, expectedProjectBindings) => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: `session-race-${checkpoint}` }, "evleda.test-run-binding.v1");
    const state = { target: "", deadlineMs: 5_000 };
    let unblock!: () => void;
    let markHit!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const hit = new Promise<void>((resolve) => { markHit = resolve; });
    let projectBindings = 0;
    let closes = 0;
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      runtimeVerificationHooksForTesting: {
        get deadlineMsForTesting() { return state.deadlineMs; },
        operationForTesting: async (label, operation) => {
          if (label !== state.target) return await operation();
          markHit();
          await gate;
          return await operation();
        },
      },
      connectSessionForTesting: async (options) => ({
        identity: fakeBoundSessionIdentity(options, 6_002),
        bindDeferredInspectionProject: async () => { projectBindings += 1; },
        close: async () => { closes += 1; },
      }) as unknown as RawKicadMcpSession,
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    const authority = await bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    });
    state.target = `KiCad MCP authority checkpoint:${checkpoint}`;
    const connecting = authority.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      mode: "readonly",
      requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort(),
    }, { deadlineAtMs: performance.now() + 2_000 });
    void connecting.catch(() => undefined);
    await hit;
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.assertCurrent({ signal: controller.signal })).rejects.toBeInstanceOf(KicadMcpRuntimeVerificationDeadlineError);
    unblock();
    await expect(connecting).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(projectBindings).toBe(expectedProjectBindings);
    expect(closes).toBe(1);
    expect((await readdir(fixture.runtimeParentRoot)).length).toBe(1);
  });

  it("disposes an unused preallocated session authority exactly once", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "dispose-unused-authority" }, "evleda.test-run-binding.v1");
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
    });
    const socket = await bridge.allocateIpcSocket({ runBindingIdentity });
    const authority = await bridge.bindSession({
      runBindingIdentity,
      ipcSocket: socket,
      mode: "readonly",
      requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
      roots: { workspaceRoot: fixture.workspace, projectRoot: fixture.project, outputRoot: fixture.outputRoot },
    });
    expect((await readdir(fixture.runtimeParentRoot)).length).toBe(1);
    await expect(authority.disposeUnused()).resolves.toBe("disposed");
    await expect(authority.disposeUnused()).resolves.toBe("disposed");
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    await expect(authority.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      mode: "readonly",
      requiredTools: [...KICAD_MCP_INSPECTION_TOOL_ALLOWLIST].sort(),
    })).rejects.toThrow(/consumed|disposed/iu);
    await expect(bridge.releaseIpcSocket(socket, runBindingIdentity)).resolves.toBe("released");
  });

  it("rejects an already-aborted verification context before I/O and poisons later bind reuse", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.assertCurrent({ signal: controller.signal, deadlineAtMs: performance.now() + 1_000 }))
      .rejects.toMatchObject({ name: "KicadMcpRuntimeVerificationDeadlineError", reason: "aborted" });
    expect(await readdir(fixture.runtimeParentRoot)).toEqual([]);
    await expect(bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
  });

  it("retains private state and poisons the bridge on a typed probe-tree uncertainty", async () => {
    const fixture = await syntheticInspectionBridgeFixture();
    const runBindingIdentity = canonicalIdentity({ run: "uncertain-probe" }, "evleda.test-run-binding.v1");
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: fixture.lockFile,
      runtimeBundle: { root: fixture.bundleRoot, manifestFile: fixture.manifestFile, expectedClosure: fixture.expectedClosure },
      runtimeParentRoot: fixture.runtimeParentRoot,
      ipcSocketParentRoot: fixture.ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: fixture.kicadCliInput,
      protectedRoots: [fixture.workspace],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: fixture.processTreeTerminatorInput,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: fixture.systemRoot, WINDIR: fixture.systemRoot },
      connectSessionForTesting: async () => {
        throw new KicadMcpTerminationUncertainError("categorical CLI probe tree uncertainty");
      },
    });
    const ipcSocket = await bridge.allocateIpcSocket({ runBindingIdentity });
    await expect(bridge.connect({
      workspaceRoot: fixture.workspace,
      projectRoot: fixture.project,
      outputRoot: fixture.outputRoot,
      ipcSocket,
      runBindingIdentity,
    })).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect((await readdir(fixture.runtimeParentRoot)).length).toBe(1);
    await expect(bridge.assertCurrent()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    await expect(bridge.releaseIpcSocket(ipcSocket, runBindingIdentity)).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
  });

  it.runIf(process.platform === "win32")("reproduces the configured runtime without launching KiCad or the sidecar", async () => {
    const repositoryRoot = await realpath(process.cwd());
    const installation = resolveRuntimeCheckPaths([], process.env, repositoryRoot);
    const runtimeRoot = installation.root;
    const manifestPath = installation.manifest;
    const lockPath = path.join(repositoryRoot, "sidecars", "kicad-mcp-pro.lock.json");
    const kicadCliPath = process.env.EVLEDA_KICAD_CLI ?? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "KiCad", "10.0", "bin", "kicad-cli.exe");
    const terminatorPath = path.join(runtimeRoot, "process-tree-terminator.exe");
    const [manifestBytes, lockBytes, cliBytes, terminatorBytes] = await Promise.all([
      readFile(manifestPath), readFile(lockPath), readFile(kicadCliPath), readFile(terminatorPath),
    ]);
    await verifyRuntime({ root: runtimeRoot, manifest: manifestPath });
    const parent = await mkdtemp(path.join(suiteRoot, "runtime-")); ownedWorkspaces.add(parent);
    const runtimeParentRoot = path.join(parent, "sessions"), ipcSocketParentRoot = path.join(parent, "ipc");
    await mkdir(runtimeParentRoot); await mkdir(ipcSocketParentRoot);
    let launches = 0;
    const bridge = await createKicadMcpInspectionBridge({
      lockFile: { path: lockPath, contentIdentity: contentIdentity(lockBytes) },
      runtimeBundle: {
        root: runtimeRoot,
        manifestFile: { path: manifestPath, contentIdentity: contentIdentity(manifestBytes) },
        expectedClosure: parseKicadMcpInspectionRuntimeManifestSummary(manifestBytes),
      },
      runtimeParentRoot,
      ipcSocketParentRoot,
      verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
      kicadCli: { path: kicadCliPath, contentIdentity: contentIdentity(cliBytes) },
      protectedRoots: [repositoryRoot, path.dirname(path.dirname(kicadCliPath))],
      processTreeSupervision: {
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        terminator: { path: terminatorPath, contentIdentity: contentIdentity(terminatorBytes) },
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
      },
      environment: { SYSTEMROOT: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      connectSessionForTesting: async () => { launches += 1; throw new Error("must not launch"); },
    });
    await expect(bridge.assertCurrent()).resolves.toBeUndefined();
    expect(launches).toBe(0);
    expect(bridge.identity.schemaVersion).toBe("evleda.kicad-mcp-runtime.v1");
  }, 60_000);

  it.runIf(process.platform === "win32")("fences an active call and confirms a resistant descendant dies with the exact root tree", async () => {
    const { workspace, project } = await roots();
    const command = fakeCommand();
    const session = await RawKicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command,
      expectedLauncherIdentity: await createKicadMcpExpectedExecutableIdentity(command.command),
      environment: process.env,
      processTreeSupervision: await realWindowsTreePolicy(),
    });
    let descendantPid: number | undefined;
    try {
      const spawned = await session.callTool("kicad_get_version", { spawnChild: true });
      descendantPid = (spawned.structuredContent as { childPid: number }).childPid;
      expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
      expect(processAlive(descendantPid)).toBe(true);
      const activeCall = session.callTool("kicad_get_version", { hang: true }, { timeoutMs: 30_000 });
      void activeCall.catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      await expect(session.close()).resolves.toBeUndefined();
      await expect(activeCall).rejects.toThrow(/did not complete safely|closed|aborted/iu);
      expect(await waitForCondition(() => !processAlive(descendantPid!))).toBe(true);
      expect(session.identity.launch.processTreeSupervision).toMatchObject({
        strategy: KICAD_MCP_WINDOWS_PROCESS_TREE_STRATEGY,
        timeoutMs: KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
        rootExitBeforeTermination: "unconfirmed",
      });
    } finally {
      await session.close().catch(() => undefined);
      if (descendantPid !== undefined && processAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it.runIf(process.platform === "win32")("never invokes taskkill after the exact root exits before the final proof", async () => {
    const { workspace, project } = await roots();
    const command = fakeCommand();
    let rootPid = 0;
    let treeLaunches = 0;
    const policy = await realWindowsTreePolicy({
      beforeFinalRootProofForTesting: async () => {
        expect(await waitForCondition(() => rootPid > 0 && !processAlive(rootPid))).toBe(true);
      },
      processRunnerForTesting: async (invocation) => {
        treeLaunches += 1;
        return {
          command: invocation.command, args: invocation.args, cwd: invocation.cwd,
          exitCode: 0, stdout: "", stderr: "", durationMs: 1,
          startedAt: "2026-09-07T00:00:00.000Z",
        };
      },
    });
    const session = await RawKicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command,
      expectedLauncherIdentity: await createKicadMcpExpectedExecutableIdentity(command.command),
      environment: process.env,
      processTreeSupervision: policy,
    });
    rootPid = session.identity.pid!;
    let descendantPid: number | undefined;
    try {
      const spawned = await session.callTool("kicad_get_version", { spawnChild: true, exitRootAfterResponse: true });
      descendantPid = (spawned.structuredContent as { childPid: number }).childPid;
      expect(await waitForCondition(() => !processAlive(rootPid))).toBe(true);
      await expect(session.close()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
      expect(treeLaunches).toBe(0);
      expect(descendantPid !== undefined && processAlive(descendantPid)).toBe(true);
      await expect(session.close()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
      expect(treeLaunches).toBe(0);
    } finally {
      if (descendantPid !== undefined && processAlive(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
        await waitForCondition(() => !processAlive(descendantPid!));
      }
    }
  });

  it.runIf(process.platform === "win32")("returns only categorical evidence and retains uncertainty when taskkill fails", async () => {
    const { workspace, project } = await roots();
    const command = fakeCommand();
    let treeLaunches = 0;
    const session = await RawKicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command,
      expectedLauncherIdentity: await createKicadMcpExpectedExecutableIdentity(command.command),
      environment: process.env,
      processTreeSupervision: await realWindowsTreePolicy({
        processRunnerForTesting: async (invocation) => {
          treeLaunches += 1;
          return {
            command: invocation.command, args: invocation.args, cwd: invocation.cwd,
            exitCode: 1, stdout: "sk-tree-secret", stderr: "C:\\private\\provider.txt",
            durationMs: 1, startedAt: "2026-09-07T00:00:00.000Z",
          };
        },
      }),
    });
    let thrown: unknown;
    try { await session.close(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(String(thrown)).not.toContain("sk-tree-secret");
    expect(String(thrown)).not.toContain("provider.txt");
    expect(treeLaunches).toBe(1);
  });

  it.runIf(process.platform === "win32")("bounds a hung pinned tree helper with exactly one launch and no fallback", async () => {
    const { workspace, project } = await roots();
    const command = fakeCommand();
    let treeLaunches = 0;
    const session = await RawKicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command,
      expectedLauncherIdentity: await createKicadMcpExpectedExecutableIdentity(command.command),
      environment: process.env,
      processTreeSupervision: await realWindowsTreePolicy({
        processRunnerForTesting: async () => {
          treeLaunches += 1;
          return await new Promise<never>(() => undefined);
        },
      }),
    });
    const started = Date.now();
    await expect(session.close()).rejects.toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(KICAD_MCP_WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS - 100);
    expect(Date.now() - started).toBeLessThan(7_500);
    expect(treeLaunches).toBe(1);
  }, 10_000);

  it.each(["readonly", "write"] as const)("supplies the exact enclosing workspace at deferred %s startup and refuses environment overrides", async (mode) => {
    const { workspace, project } = await roots();
    const launchCwd = await mkdtemp(path.join(suiteRoot, "evleda-deferred-cwd-"));
    ownedWorkspaces.add(launchCwd);
    const outputRoot = path.join(workspace, ".evleda-mcp-output");
    const options = {
      workspaceRoot: workspace, projectRoot: project, outputRoot, launchCwd,
      deferProjectBinding: true, mode,
      ...(mode === "write" ? { freshProject: true } : {}),
      command: fakeCommand("deferred-workspace"),
      environment: {
        ...process.env,
        KICAD_MCP_WORKSPACE_ROOT: path.join(workspace, "wrong-workspace"),
        KICAD_MCP_PROJECT_DIR: path.join(workspace, "wrong-project"),
        KICAD_MCP_OUTPUT_DIR: path.join(workspace, "wrong-output"),
      },
      requiredTools: ["kicad_get_version"],
    };
    await expect(KicadMcpSession.connect({ ...options, extraEnvironment: { KICAD_MCP_WORKSPACE_ROOT: project } })).rejects.toThrow(/not allowlisted/iu);
    const session = await KicadMcpSession.connect(options);
    try {
      await expect(session.callTool("kicad_get_version")).rejects.toThrow(/host-bound/iu);
      await session.bindDeferredInspectionProject();
      const result = await session.callTool("kicad_get_version", { inspectStartup: true });
      expect(result.structuredContent).toMatchObject({ mode, opaque: {
        workspaceSha256: createHash("sha256").update(await realpath(workspace)).digest("hex"),
        startupProjectPresent: false,
        startupOutputPresent: false,
      } });
      await expect(session.bindDeferredInspectionProject()).rejects.toThrow(/already consumed/iu);
    } finally {
      await session.close();
    }
  });

  it("discovers only controller-allowed read tools and passes an allowlisted environment", async () => {
    const { workspace, project } = await roots();
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand("single"),
      environment: {
        ...process.env,
        TEMP: "C:\\host-ipc-temp",
        TMP: "C:\\host-ipc-temp",
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        EVLEDA_TEST_SECRET: "must-not-cross-boundary",
      },
      maxStderrBytes: 256,
    });

    try {
      expect(session.listTools().map((tool) => [tool.name, tool.permission])).toEqual([
        ["kicad_get_version", "read"],
      ]);
      expect(JSON.stringify(session.listTools())).not.toContain("sk-sidecar-description-secret");
      expect(JSON.stringify(session.listTools())).not.toContain("C:/private");
      expect(session.identity).toMatchObject({
        sidecar: { version: "3.33.3", auditedCommit: KICAD_MCP_PRO_AUDITED_COMMIT },
        server: { name: KICAD_MCP_SERVER_NAME, version: KICAD_MCP_SERVER_VERSION, authenticated: true },
        mode: "readonly",
        launch: {
          schemaVersion: "evleda.kicad-mcp-launch.v1",
          transport: "stdio",
          profile: "full",
          mode: "readonly",
          launcherPathIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
          argumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        launcher: {
          pathIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          sizeBytes: expect.any(Number),
        },
        toolDiscovery: { pageCount: 1, toolCount: 4, pageCursorIdentities: [null] },
      });
      expect(JSON.stringify(session.identity)).not.toContain(workspace);
      expect(JSON.stringify(session.identity)).not.toContain(project);
      expect(JSON.stringify(session.identity)).not.toContain(await realpath(process.execPath));

      const projectFile = path.join(project, "robot.kicad_pro");
      const result = await session.callTool("kicad_get_version", { project_file: projectFile });
      expect(result.structuredContent).toEqual({
        ok: true,
        mode: "readonly",
        secret: null,
        pathValue: "[redacted path]",
        temp: "[redacted path]",
        childPid: null,
        keys: expect.any(Array),
        inheritedDefaults: ["", "", ""],
        opaque: {},
      });
      expect((result.structuredContent as { keys: string[] }).keys).not.toContain("EVLEDA_TEST_SECRET");
      expect(session.stderr).toMatchObject({ category: "present", truncated: false, seenBytes: 149 });

      const secret = await session.callTool("kicad_get_version", { rawSecret: true });
      expect(JSON.stringify(secret)).not.toContain("sk-sidecar-secret-value");
      expect(secret.structuredContent).toMatchObject({ secret: "[redacted sensitive sidecar value]" });

      await expect(session.callTool("sch_apply_plan")).rejects.toBeInstanceOf(
        KicadMcpAuthorizationError,
      );
      await expect(session.callTool("export_manufacturing_package")).rejects.toThrow(
        /permanently forbidden/iu,
      );
      await expect(session.callTool("dfm_run_manufacturer_check")).rejects.toThrow(
        /permanently forbidden/iu,
      );
      await expect(
        session.callTool("kicad_get_version", { project_file: path.join(project, "..", "escape") }),
      ).rejects.toThrow(/escapes/iu);
      const providerTextKey = "SECRET_PROVIDER_PROMPT_SHOULD_NOT_RETURN";
      let providerArgumentError: unknown;
      try { await session.callTool("kicad_get_version", { [providerTextKey]: "../escape" }); }
      catch (error) { providerArgumentError = error; }
      expect(String(providerArgumentError)).not.toContain(providerTextKey);
    } finally {
      const pidBeforeClose = session.identity.pid;
      await session.close();
      expect(session.identity.pid).toBe(pidBeforeClose);
      await session.close();
    }
  });

  it("keeps live PCB source private and preserves more than 64 KiB of exact native serialization", async () => {
    const { workspace, project } = await roots(); const expected = path.join(project, "active.kicad_pcb");
    const source = `(kicad_pcb\r\n  (gr_text "${project.replaceAll("\\", "\\\\")}/embedded-file")\r  (gr_text "C:\\\\native\\\\board.kicad_pcb /var/private/board.kicad_pcb quoted \\\"label\\\" literal \\\\n Ω")\r\n${"  (gr_text \"padding\")\n".repeat(4_000)})\r\n`;
    expect(Buffer.byteLength(source, "utf8")).toBeGreaterThan(64 * 1024);
    const fixture = await livePcbFixture(project, [livePcbEnvelope(livePcbDocument(project, source))], { publicSource: source });
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, requiredTools: [LIVE_PCB_TOOL] });
    try {
      expect(session.listTools().map((tool) => tool.name)).not.toContain(LIVE_PCB_TOOL);
      await expect(session.callTool(LIVE_PCB_TOOL)).rejects.toBeInstanceOf(KicadMcpAuthorizationError);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(expected, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(Buffer.from(await session.readActivePcbSource(expected), "utf8")).toEqual(Buffer.from(source, "utf8"));
      await expect(session.assertActivePcb(expected)).resolves.toBeUndefined();
      const publicResult = await session.callTool("pcb_get_board_as_string");
      const publicText = (publicResult.structuredContent as { result: string }).result;
      expect(publicText).not.toBe(source); expect(publicText).not.toContain(project); expect(publicText).not.toContain("C:\\\\native"); expect(publicText).not.toContain("/var/private");
      expect(publicText).not.toContain("\r"); expect(publicText).toContain("[truncated sidecar evidence]");
      const calls = (await readFile(fixture.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls.slice(0, 2)).toEqual([{ name: LIVE_PCB_TOOL, arguments: {} }, { name: LIVE_PCB_TOOL, arguments: {} }]);
    } finally { await session.close(); }
  });

  it("requires host live PCB capability and denies readonly or public access before IPC", async () => {
    const { workspace, project } = await roots(); const expected = path.join(project, "active.kicad_pcb");
    const absent = await livePcbFixture(project, [livePcbEnvelope(livePcbDocument(project))], { advertise: false });
    await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: absent.command, requiredTools: [LIVE_PCB_TOOL] })).rejects.toThrow(/not advertised/iu);
    const missing = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: absent.command });
    await expect(missing.assertActivePcb(expected)).rejects.toThrow(/lacks its host live PCB/iu);
    await expect(missing.callTool("pcb_save")).rejects.toThrow(/closed/iu); await missing.close();
    await expect(readFile(absent.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const fixture = await livePcbFixture(project, [livePcbEnvelope(livePcbDocument(project))]);
    await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command, requiredTools: [LIVE_PCB_TOOL] })).rejects.toThrow(/capability\/allowlist mismatch/iu);
    await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command, readToolAllowlist: [LIVE_PCB_TOOL] })).rejects.toThrow(/cannot add unreviewed tool/iu);
    const readonly = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command });
    try {
      expect(readonly.listTools().map((tool) => tool.name)).not.toContain(LIVE_PCB_TOOL);
      await expect(readonly.readActivePcbSource(expected)).rejects.toThrow(/host-only write-session/iu);
      await expect(readonly.assertActivePcb(expected)).rejects.toThrow(/host-only write-session/iu);
      await expect(readonly.callTool(LIVE_PCB_TOOL)).rejects.toBeInstanceOf(KicadMcpAuthorizationError);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await readonly.close(); }
  });

  it("rejects malformed or inconsistent raw live PCB envelopes with no sanitized or file fallback", async () => {
    const { workspace, project } = await roots(); const expected = path.join(project, "active.kicad_pcb");
    await writeFile(expected, "(kicad_pcb (version 20260101))", "utf8");
    const document = livePcbDocument(project); const valid = livePcbEnvelope(document);
    const { boardSource: _source, ...missingSource } = document;
    const cases = [
      { ...valid, content: [] }, { ...valid, content: [...valid.content as unknown[], ...valid.content as unknown[]] },
      { content: valid.content, isError: false }, { structuredContent: document, isError: false },
      { ...valid, extra: "C:/private/live-document" }, { ...valid, content: [{ type: "text", text: JSON.stringify(document), annotations: {} }] },
      { ...valid, content: [{ type: "text", text: JSON.stringify(document).replace('{"schemaVersion":', '{"schemaVersion":"duplicate","schemaVersion":') }] },
      { ...valid, content: [{ type: "text", text: "not JSON C:/private/live-document" }] },
      { ...valid, content: [{ type: "text", text: JSON.stringify({ ...document, boardSource: "changed serialization" }) }] },
      livePcbEnvelope({ ...document, documentType: "schematic" }), livePcbEnvelope(missingSource),
      livePcbEnvelope({ result: document }), livePcbEnvelope({ ...document, boardSource: "" }),
      livePcbEnvelope({ ...document, boardSource: "(kicad_pcb\0)" }), livePcbEnvelope({ ...document, boardSource: "(kicad_pcb\ud800)" }),
      { isError: true, content: [{ type: "text", text: "Missing, multiple, or changed live PCB C:/private/live-document" }] },
    ];
    for (const result of cases) {
      const fixture = await livePcbFixture(project, [result]);
      const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, requiredTools: [LIVE_PCB_TOOL] });
      let error: unknown;
      try { await session.readActivePcbSource(expected); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(project); expect(String(error)).not.toContain("C:/private");
      await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu); await session.close();
    }
  });

  it("rejects an unbound expected live PCB path before issuing IPC or a board action", async () => {
    const { workspace, project, canonical } = await roots();
    for (const expected of ["active.kicad_pcb", path.join(canonical, "active.kicad_pcb"), path.join(project, "nested", "active.kicad_pcb")]) {
      const fixture = await livePcbFixture(project, [livePcbEnvelope(livePcbDocument(project))]);
      const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
      await expect(session.assertActivePcb(expected)).rejects.toThrow();
      await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu); await session.close();
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("binds live PCB project directory and exact basename and rejects a document changed between checks", async () => {
    const { workspace, project, canonical } = await roots(); const expected = path.join(project, "active.kicad_pcb");
    const nested = path.join(project, "other"); await mkdir(nested);
    const alias = path.join(workspace, "project-alias"); await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    const document = livePcbDocument(project);
    const cases = [
      { ...document, projectPath: canonical }, { ...document, projectPath: nested }, { ...document, projectPath: alias },
      { ...document, projectPath: "working-copy" }, { ...document, projectPath: `${project}\n` },
      { ...document, boardFilename: "other.kicad_pcb" }, { ...document, boardFilename: "../active.kicad_pcb" },
      { ...document, boardFilename: expected }, { ...document, boardFilename: "active.kicad_pro" },
    ];
    for (const candidate of cases) {
      const fixture = await livePcbFixture(project, [livePcbEnvelope(candidate)]);
      const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
      await expect(session.assertActivePcb(expected)).rejects.toThrow();
      await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu); await session.close();
    }
    const fixture = await livePcbFixture(project, [livePcbEnvelope(document), livePcbEnvelope({ ...document, boardFilename: "switched.kicad_pcb" })]);
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
    await expect(session.assertActivePcb(expected)).resolves.toBeUndefined();
    await expect(session.readActivePcbSource(expected)).rejects.toThrow(/exact expected board/iu); await session.close();
  });

  it("rejects live PCB source at the effective UTF-8 envelope or portable string limit instead of truncating", async () => {
    const { workspace, project } = await roots(); const expected = path.join(project, "active.kicad_pcb");
    const connect = async (results: readonly unknown[], maxMessageBytes: number) => {
      const fixture = await livePcbFixture(project, results);
      return await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, maxMessageBytes, timeoutMs: 1_000 });
    };
    const ascii = "a".repeat(1_000); const unicode = "é".repeat(1_000);
    const asciiEnvelope = livePcbEnvelope(livePcbDocument(project, ascii)); const unicodeEnvelope = livePcbEnvelope(livePcbDocument(project, unicode));
    expect(Buffer.byteLength(JSON.stringify(asciiEnvelope), "utf8")).toBeLessThan(4_096);
    expect(Buffer.byteLength(unicode, "utf8")).toBeLessThan(4_096);
    expect(Buffer.byteLength(JSON.stringify(unicodeEnvelope), "utf8")).toBeGreaterThan(4_096);
    const bounded = await connect([asciiEnvelope, unicodeEnvelope], 4_096);
    expect(await bounded.readActivePcbSource(expected)).toBe(ascii);
    await expect(bounded.readActivePcbSource(expected)).rejects.toThrow(); await bounded.close();
    const exactLimit = "a".repeat(1024 * 1024); const aboveLimit = `${exactLimit}é`;
    const portable = await connect([livePcbEnvelope(livePcbDocument(project, exactLimit)), livePcbEnvelope(livePcbDocument(project, aboveLimit))], 4 * 1024 * 1024);
    expect(await portable.readActivePcbSource(expected)).toBe(exactLimit);
    await expect(portable.readActivePcbSource(expected)).rejects.toThrow(/strict bounded JSON/iu);
    await expect(portable.callTool("pcb_save")).rejects.toThrow(/closed/iu); await portable.close();
  });

  it("bounds a host live PCB read by the existing session timeout and closes on failure", async () => {
    const { workspace, project } = await roots(); const fixture = await livePcbFixture(project, ["hang"]);
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, timeoutMs: 500 });
    await expect(session.readActivePcbSource(path.join(project, "active.kicad_pcb"))).rejects.toThrow(/did not complete safely/iu);
    await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu); await session.close();
  });

  it("keeps doc2 live PCB pad snapshot capability unsupported without a public or file fallback", async () => {
    const { workspace, project } = await roots();
    const expected = path.join(project, "active.kicad_pcb");
    const source = "(kicad_pcb (version 20260101))\n";
    await writeFile(expected, source, "utf8");
    const fixture = await livePcbFixture(project, [livePcbEnvelope(livePcbDocument(project, source))], { publicSource: source });
    await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, requiredTools: [LIVE_PCB_PAD_TOOL] })).rejects.toThrow(/not advertised/iu);
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
    expect(await session.readActivePcbSource(expected)).toBe(source);
    await expect(session.readLivePcbPadSnapshot([])).rejects.toThrow(/lacks its host live PCB pad snapshot capability/iu);
    await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu);
    await session.close();
    const calls = (await readFile(fixture.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([{ name: LIVE_PCB_TOOL, arguments: {} }]);
    expect(await readFile(expected, "utf8")).toBe(source);
  });

  it("denies public and readonly live PCB pad snapshot access before IPC", async () => {
    const { workspace, project } = await roots();
    const fixture = await livePcbFixture(project, [livePcbEnvelope(livePcbDocument(project))], { padTool: livePcbPadTool() });
    await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command, requiredTools: [LIVE_PCB_PAD_TOOL] })).rejects.toThrow(/capability\/allowlist mismatch/iu);
    await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command, readToolAllowlist: [LIVE_PCB_PAD_TOOL] })).rejects.toThrow(/cannot add unreviewed tool/iu);
    await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, writeToolAllowlist: [LIVE_PCB_PAD_TOOL] })).rejects.toThrow(/cannot add unreviewed tool/iu);
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command });
    try {
      expect(session.listTools().map((tool) => tool.name)).not.toContain(LIVE_PCB_PAD_TOOL);
      await expect(session.readLivePcbPadSnapshot([])).rejects.toThrow(/host-only write-session capability/iu);
      await expect(session.callTool(LIVE_PCB_PAD_TOOL, { requested_primitive_ids: [] })).rejects.toBeInstanceOf(KicadMcpAuthorizationError);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await session.close(); }
  });

  it("requires a host-bound project before a registered live PCB pad snapshot read", async () => {
    const { workspace, project } = await roots();
    const launchCwd = await mkdtemp(path.join(suiteRoot, "evleda-live-pad-deferred-"));
    ownedWorkspaces.add(launchCwd);
    const fixture = await livePcbFixture(project, [], { padTool: livePcbPadTool() });
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, launchCwd, deferProjectBinding: true, mode: "write", freshProject: true, command: fixture.command, requiredTools: [LIVE_PCB_PAD_TOOL] });
    try {
      await expect(session.readLivePcbPadSnapshot([])).rejects.toThrow(/must be host-bound/iu);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await session.close(); }
  });

  it("keeps registered live PCB pad snapshots private and forwards exact UUID order and raw envelopes", async () => {
    const { workspace, project } = await roots();
    const source = `(kicad_pcb\r\n (gr_text "C:/private/native-source Ω")\r\n${" (gr_text \"padding\")\n".repeat(4_000)})\r\n`;
    expect(Buffer.byteLength(source, "utf8")).toBeGreaterThan(64 * 1024);
    const envelope = livePcbEnvelope(livePcbPadPayload(project, source));
    const fixture = await livePcbFixture(project, [], { padTool: livePcbPadTool(), padResults: [envelope] });
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, requiredTools: [LIVE_PCB_PAD_TOOL] });
    try {
      expect(session.listTools().map((tool) => tool.name)).not.toContain(LIVE_PCB_PAD_TOOL);
      await expect(session.callTool(LIVE_PCB_PAD_TOOL, { requested_primitive_ids: LIVE_PCB_PAD_IDS })).rejects.toBeInstanceOf(KicadMcpAuthorizationError);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const requested = [LIVE_PCB_PAD_IDS[1], LIVE_PCB_PAD_IDS[0]];
      const read = session.readLivePcbPadSnapshot(requested);
      requested.reverse();
      expect(await read).toEqual(envelope);
      expect(await session.readLivePcbPadSnapshot([])).toEqual(envelope);
      const calls = (await readFile(fixture.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toEqual([
        { name: LIVE_PCB_PAD_TOOL, arguments: { requested_primitive_ids: [LIVE_PCB_PAD_IDS[1], LIVE_PCB_PAD_IDS[0]] } },
        { name: LIVE_PCB_PAD_TOOL, arguments: { requested_primitive_ids: [] } },
      ]);
      await expect(readFile(path.join(project, "active.kicad_pcb"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await session.close(); }
  });

  it("rejects unexpected live PCB pad snapshot registration metadata before IPC", async () => {
    const { workspace, project } = await roots();
    expect(createHash("sha256").update(canonicalJson(livePcbPadProtocol.outputSchema), "utf8").digest("hex")).toBe(livePcbPadProtocol.outputSchemaCanonicalSha256);
    const valid = livePcbPadTool();
    const { outputSchema: _output, ...missingOutput } = valid;
    const cases = [
      { ...valid, inputSchema: { ...livePcbPadProtocol.inputSchema, additionalProperties: true } },
      { ...valid, inputSchema: { ...livePcbPadProtocol.inputSchema, required: [] } },
      { ...valid, annotations: { ...livePcbPadProtocol.annotations, readOnlyHint: false } },
      { ...valid, annotations: { ...livePcbPadProtocol.annotations, destructiveHint: true } },
      { ...valid, annotations: undefined },
      { ...valid, _meta: {} },
      missingOutput,
      { ...valid, outputSchema: { ...livePcbPadProtocol.outputSchema, additionalProperties: true } },
    ];
    for (const padTool of cases) {
      const fixture = await livePcbFixture(project, [], { padTool });
      // Registration is checked even when the caller did not require the tool.
      await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command })).rejects.toThrow(/pad snapshot registration does not match/iu);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects invalid or duplicate live PCB pad UUID selections before IPC without coercing them", async () => {
    const { workspace, project } = await roots();
    const selections: unknown[] = [
      LIVE_PCB_PAD_IDS[0], [1], [null], [LIVE_PCB_PAD_IDS[0].toUpperCase()], [` ${LIVE_PCB_PAD_IDS[0]}`],
      [`pad:${LIVE_PCB_PAD_IDS[0]}`], [LIVE_PCB_PAD_IDS[0], LIVE_PCB_PAD_IDS[0]], Array(513).fill(LIVE_PCB_PAD_IDS[0]),
    ];
    for (const selection of selections) {
      const fixture = await livePcbFixture(project, [], { padTool: livePcbPadTool() });
      const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
      await expect(session.readLivePcbPadSnapshot(selection as readonly string[])).rejects.toThrow(/physical UUID/iu);
      await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu);
      await session.close();
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves unknown live PCB pad UUID requests and closes on categorical producer failure", async () => {
    const { workspace, project } = await roots();
    const unknownId = "f0000000-0000-0000-0000-000000000009";
    const fixture = await livePcbFixture(project, [], { padTool: livePcbPadTool(), padResults: [{ isError: true, content: [{ type: "text", text: "Unknown UUID in C:/private/pad-source" }] }] });
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
    await expect(session.readLivePcbPadSnapshot([unknownId])).rejects.toThrow("categorical live PCB pad snapshot failure evidence");
    await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu);
    await session.close();
    expect((await readFile(fixture.callsPath, "utf8")).trim()).toBe(JSON.stringify({ name: LIVE_PCB_PAD_TOOL, arguments: { requested_primitive_ids: [unknownId] } }));
  });

  it("rejects oversized or truncated live PCB pad snapshot transport and closes without fallback", async () => {
    for (const kind of ["oversized", "truncated", "hang"]) {
      const { workspace, project } = await roots();
      const result = kind === "oversized" ? livePcbEnvelope(livePcbPadPayload(project, "é".repeat(2_000))) : kind;
      if (kind === "oversized") expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeGreaterThan(8_192);
      const fixture = await livePcbFixture(project, [], { padTool: livePcbPadTool(), padResults: [result] });
      const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, maxMessageBytes: 8_192, timeoutMs: 500 });
      await expect(session.readLivePcbPadSnapshot([])).rejects.toThrow();
      await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu);
      await session.close();
      expect((await readFile(fixture.callsPath, "utf8")).trim()).toBe(JSON.stringify({ name: LIVE_PCB_PAD_TOOL, arguments: { requested_primitive_ids: [] } }));
    }
  });

  it("keeps schematic connectivity batch private and forwards one detached complete host plan", async () => {
    const { workspace, project } = await roots();
    const plan = await schematicBatchPlan(project);
    const originalArgs = structuredClone(plan.args);
    const fixture = await livePcbFixture(project, [], { batchTool: schematicBatchTool(), batchResults: [plan.receipt], batchAfterSource: plan.after });
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, requiredTools: [SCHEMATIC_BATCH_TOOL] });
    try {
      expect(session.supportsSchematicConnectivityBatch()).toBe(true);
      expect(session.listTools().map((tool) => tool.name)).not.toContain(SCHEMATIC_BATCH_TOOL);
      await expect(session.callTool(SCHEMATIC_BATCH_TOOL, plan.args)).rejects.toBeInstanceOf(KicadMcpAuthorizationError);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const pending = session.applySchematicConnectivityBatch(plan.args);
      plan.args.wires[0]!.x2_mm = 123;
      plan.args.global_labels[0]!.name = "caller changed later";
      plan.args.no_connects.push({ x_mm: 40.64, y_mm: 40.64 });
      expect(await pending).toEqual(plan.receipt);
      expect((await readFile(fixture.callsPath, "utf8")).trim()).toBe(JSON.stringify({ name: SCHEMATIC_BATCH_TOOL, arguments: originalArgs }));
      expect(await readFile(plan.schematicFile, "utf8")).toBe(plan.after);
      expect(await readFile(plan.projectFile, "utf8")).toBe("{}\n");
      expect(session.supportsSchematicConnectivityBatch()).toBe(true);
    } finally { await session.close(); }
  });

  it("reports unavailable schematic connectivity batch without an old-runtime or public fallback", async () => {
    const { workspace, project } = await roots();
    const plan = await schematicBatchPlan(project);
    const fixture = await livePcbFixture(project, []);
    await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, requiredTools: [SCHEMATIC_BATCH_TOOL] })).rejects.toThrow(/not advertised/iu);
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
    expect(session.supportsSchematicConnectivityBatch()).toBe(false);
    await expect(session.applySchematicConnectivityBatch(plan.args)).rejects.toThrow(/lacks its host schematic connectivity batch/iu);
    expect(session.supportsSchematicConnectivityBatch()).toBe(false);
    await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu);
    await session.close();
    await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(plan.schematicFile, "utf8")).toBe(plan.before);
  });

  it("requires actual write mode and a bound project for schematic connectivity batch admission", async () => {
    const { workspace, project } = await roots();
    const plan = await schematicBatchPlan(project);
    const fixture = await livePcbFixture(project, [], { batchTool: schematicBatchTool() });
    await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command, requiredTools: [SCHEMATIC_BATCH_TOOL] })).rejects.toThrow(/capability\/allowlist mismatch/iu);
    for (const key of ["readToolAllowlist", "writeToolAllowlist"] as const) {
      await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, [key]: [SCHEMATIC_BATCH_TOOL] })).rejects.toThrow(/cannot add unreviewed tool/iu);
    }
    const readonly = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command });
    expect(readonly.supportsSchematicConnectivityBatch()).toBe(false);
    await expect(readonly.applySchematicConnectivityBatch(plan.args)).rejects.toThrow(/host-only write-session/iu);
    await readonly.close();
    const launchCwd = await mkdtemp(path.join(suiteRoot, "evleda-batch-deferred-"));
    ownedWorkspaces.add(launchCwd);
    const unbound = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, launchCwd, deferProjectBinding: true, mode: "write", freshProject: true, command: fixture.command, requiredTools: [SCHEMATIC_BATCH_TOOL] });
    expect(unbound.supportsSchematicConnectivityBatch()).toBe(false);
    await expect(unbound.applySchematicConnectivityBatch(plan.args)).rejects.toThrow(/must be host-bound/iu);
    await unbound.close();
    await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins the honestly mutating schematic connectivity batch registration before IPC", async () => {
    const { workspace, project } = await roots();
    const valid = schematicBatchTool();
    for (const batchTool of [
      { ...valid, annotations: { ...schematicBatchProtocol.annotations, readOnlyHint: true } },
      { ...valid, annotations: { ...schematicBatchProtocol.annotations, destructiveHint: false } },
      { ...valid, annotations: { ...schematicBatchProtocol.annotations, idempotentHint: true } },
      { ...valid, inputSchema: { ...schematicBatchProtocol.inputSchema, additionalProperties: true } },
      { ...valid, outputSchema: { ...schematicBatchProtocol.outputSchema, additionalProperties: true } },
      { ...valid, _meta: {} },
    ]) {
      const fixture = await livePcbFixture(project, [], { batchTool });
      await expect(KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command })).rejects.toThrow(/batch registration does not match/iu);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects incomplete or coerced schematic connectivity batch plans before IPC", async () => {
    const { workspace, project } = await roots();
    const plan = await schematicBatchPlan(project);
    const { junctions: _junctions, ...incomplete } = plan.args;
    for (const args of [
      incomplete, { ...plan.args, extra: true }, { ...plan.args, normalization_version: "other" },
      { ...plan.args, wires: JSON.stringify(plan.args.wires) },
      { ...plan.args, wires: [{ ...plan.args.wires[0], x1_mm: "10.16" }] },
      { ...plan.args, global_labels: [{ ...plan.args.global_labels[0], shape: "input" }] },
      { ...plan.args, expected_before_size_bytes: String(plan.args.expected_before_size_bytes) },
    ]) {
      const fixture = await livePcbFixture(project, [], { batchTool: schematicBatchTool() });
      const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
      await expect(session.applySchematicConnectivityBatch(args)).rejects.toThrow(/complete-plan schema/iu);
      await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu);
      await session.close();
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(plan.schematicFile, "utf8")).toBe(plan.before);
    }
  });

  it("binds schematic connectivity batch paths and independently verifies the exact source precondition", async () => {
    const { workspace, project, canonical } = await roots();
    const plan = await schematicBatchPlan(project);
    const foreign = await schematicBatchPlan(canonical);
    const alias = path.join(workspace, "batch-project-alias");
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    const cases = [
      { ...plan.args, expected_before_sha256: "0".repeat(64) },
      { ...plan.args, expected_before_size_bytes: plan.args.expected_before_size_bytes + 1 },
      { ...plan.args, project_file: foreign.projectFile, schematic_file: foreign.schematicFile },
      { ...plan.args, project_file: path.join(alias, "active.kicad_pro"), schematic_file: path.join(alias, "active.kicad_sch") },
      { ...plan.args, schematic_file: "active.kicad_sch" },
      { ...plan.args, project_file: path.join(project, "other.kicad_pro") },
    ];
    for (const args of cases) {
      const fixture = await livePcbFixture(project, [], { batchTool: schematicBatchTool() });
      const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
      await expect(session.applySchematicConnectivityBatch(args)).rejects.toThrow();
      await session.close();
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(plan.schematicFile, "utf8")).toBe(plan.before);
    expect(await readFile(foreign.schematicFile, "utf8")).toBe(foreign.before);
  });

  it("holds exclusive session access for an in-flight schematic connectivity batch", async () => {
    const { workspace, project } = await roots();
    const plan = await schematicBatchPlan(project);
    const fixture = await livePcbFixture(project, [], { batchTool: schematicBatchTool(), batchResults: ["hang"], batchAfterSource: plan.after });
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, timeoutMs: 500 });
    const pending = session.applySchematicConnectivityBatch(plan.args);
    const terminal = expect(pending).rejects.toThrow(/WRITE_UNCERTAIN_TERMINAL/iu);
    expect(session.supportsSchematicConnectivityBatch()).toBe(false);
    await expect(session.callTool("pcb_save")).rejects.toThrow(/exclusive session access/iu);
    await expect(session.readActivePcbSource(path.join(project, "active.kicad_pcb"))).rejects.toThrow(/exclusive session access/iu);
    await expect(session.readLivePcbPadSnapshot([])).rejects.toThrow(/exclusive session access/iu);
    await expect(session.applySchematicConnectivityBatch(plan.args)).rejects.toThrow(/idle session/iu);
    await terminal;
    await session.close();
    expect((await readFile(fixture.callsPath, "utf8")).trim()).toBe(JSON.stringify({ name: SCHEMATIC_BATCH_TOOL, arguments: plan.args }));
    expect(await readFile(plan.schematicFile, "utf8")).toBe(plan.after);
  });

  it("rejects schematic connectivity batch admission while another session read is active", async () => {
    const { workspace, project } = await roots();
    const plan = await schematicBatchPlan(project);
    const fixture = await livePcbFixture(project, ["hang"], { batchTool: schematicBatchTool() });
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, timeoutMs: 500 });
    const pending = session.readActivePcbSource(path.join(project, "active.kicad_pcb"));
    const stopped = expect(pending).rejects.toThrow();
    expect(session.supportsSchematicConnectivityBatch()).toBe(false);
    await expect(session.applySchematicConnectivityBatch(plan.args)).rejects.toThrow(/idle session/iu);
    await stopped;
    await session.close();
    expect((await readFile(fixture.callsPath, "utf8")).trim()).toBe(JSON.stringify({ name: LIVE_PCB_TOOL, arguments: {} }));
    expect(await readFile(plan.schematicFile, "utf8")).toBe(plan.before);
  });

  it("treats failed or unbounded schematic connectivity batch receipts as uncertain writes", async () => {
    for (const kind of ["categorical", "malformed", "oversized", "truncated", "hang", "project-change"]) {
      const { workspace, project } = await roots();
      const plan = await schematicBatchPlan(project);
      const result = kind === "categorical" ? { isError: true, content: [{ type: "text", text: "WRITE_UNCERTAIN_TERMINAL C:/private/schema" }] }
        : kind === "malformed" ? livePcbEnvelope({ ...(plan.receipt.structuredContent as Record<string, unknown>), applied: false })
          : kind === "oversized" ? livePcbEnvelope({ ...(plan.receipt.structuredContent as Record<string, unknown>), projectFile: "x".repeat(40_000) })
            : kind === "project-change" ? plan.receipt : kind;
      const fixture = await livePcbFixture(project, [], { batchTool: schematicBatchTool(), batchResults: [result], batchAfterSource: plan.after, ...(kind === "project-change" ? { batchProjectAfter: "{\"changed\":true}\n" } : {}) });
      const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command, maxMessageBytes: 32_768, timeoutMs: 500 });
      const failure = await session.applySchematicConnectivityBatch(plan.args).catch((error: unknown) => error);
      expect((failure as Error).message).toMatch(/WRITE_UNCERTAIN_TERMINAL/iu);
      if (kind === "categorical") {
        expect(((failure as Error).cause as Error).cause).toEqual({ operation: SCHEMATIC_BATCH_TOOL, response: result });
        expect(String(failure)).not.toContain("C:/private/schema");
        expect(JSON.stringify(failure)).not.toContain("C:/private/schema");
      }
      await expect(session.callTool("pcb_save")).rejects.toThrow(/closed/iu);
      await session.close();
      expect((await readFile(fixture.callsPath, "utf8")).trim()).toBe(JSON.stringify({ name: SCHEMATIC_BATCH_TOOL, arguments: plan.args }));
      // Session does not fabricate a rollback; the host checkpoint owner must restore this source.
      expect(await readFile(plan.schematicFile, "utf8")).toBe(plan.after);
    }
  });

  it("preserves the schematic connectivity batch reply when its terminal teardown also fails", async () => {
    const { workspace, project } = await roots();
    const plan = await schematicBatchPlan(project);
    const reply = { isError: true, content: [{ type: "text", text: "original private batch refusal" }] };
    const fixture = await livePcbFixture(project, [], { batchTool: schematicBatchTool(), batchResults: [reply] });
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true, command: fixture.command });
    const originalClose = session.close.bind(session);
    const close = vi.spyOn(session, "close").mockImplementation(async () => { await originalClose(); throw new Error("secondary teardown failure"); });
    try {
      const failure = await session.applySchematicConnectivityBatch(plan.args).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KicadMcpTerminationUncertainError);
      expect(((failure as Error).cause as Error).cause).toEqual({ operation: SCHEMATIC_BATCH_TOOL, response: reply });
      expect(String(failure)).not.toMatch(/original private|secondary teardown/iu);
    } finally { close.mockRestore(); await session.close(); }
  });

  it("runs the KiCad CLI version probe with only explicit pinned environment", async () => {
    const { workspace, project } = await roots();
    const installRoot = path.join(workspace, "fake-kicad");
    const bin = path.join(installRoot, "bin");
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(path.join(installRoot, "share", "kicad", "symbols"), { recursive: true }),
      mkdir(path.join(installRoot, "share", "kicad", "footprints"), { recursive: true }),
      mkdir(path.join(installRoot, "share", "kicad", "template"), { recursive: true }),
    ]);
    const cli = path.join(bin, process.platform === "win32" ? "kicad-cli.exe" : "kicad-cli");
    await copyFile(process.execPath, cli);
    if (process.platform !== "win32") await chmod(cli, 0o700);
    const expectedKicadCliIdentity = await createKicadMcpExpectedExecutableIdentity(cli);
    const sidecarIdentity = await createKicadMcpExpectedExecutableIdentity(process.execPath);
    await expect(RawKicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand(),
      expectedLauncherIdentity: sidecarIdentity,
      kicadCliPath: cli,
      environment: process.env,
    })).rejects.toThrow(/path and expected identity must be supplied together/iu);
    const probes: Parameters<import("../../src/integrations/bounded-process.js").BoundedProcessRunner>[0][] = [];
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand(),
      kicadCliPath: cli,
      expectedKicadCliIdentity,
      environment: {
        ...process.env,
        PATH: "C:\\attacker-path",
        PATHEXT: ".EXE;.BAT;.CMD",
        OPENAI_API_KEY: "sk-version-probe-secret",
      },
      processRunnerForTesting: async (invocation) => {
        probes.push(invocation);
        return { command: invocation.command, args: invocation.args, cwd: invocation.cwd, exitCode: 0, stdout: "10.0.3\n", stderr: "", durationMs: 1, startedAt: "2026-09-07T00:00:00.000Z" };
      },
    });
    try {
      expect(probes).toHaveLength(1);
      expect(probes[0]).toMatchObject({ command: await realpath(cli), args: ["version"], maxOutputBytes: 16 * 1024 });
      expect(probes[0]!.env).not.toHaveProperty("PATH");
      expect(probes[0]!.env).not.toHaveProperty("PATHEXT");
      expect(probes[0]!.env).not.toHaveProperty("OPENAI_API_KEY");
      const result = await session.callTool("kicad_get_version");
      const keys = (result.structuredContent as { keys: string[]; inheritedDefaults: unknown[] }).keys;
      expect(keys).not.toContain("OPENAI_API_KEY");
      expect((result.structuredContent as { inheritedDefaults: unknown[] }).inheritedDefaults).toEqual(["", "", ""]);
    } finally { await session.close(); }
  });

  it("preserves host TEMP/TMP and rejects caller temp redirection", async () => {
    const { workspace, project, canonical } = await roots();
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      mode: "write",
      isolatedWorkingCopy: { canonicalProjectRoot: canonical },
      command: fakeCommand(),
      environment: { ...process.env, TEMP: "C:\\host-ipc-temp", TMP: "C:\\host-ipc-temp" },
    });
    try {
      await expect(session.callTool("kicad_get_version")).resolves.toMatchObject({
        structuredContent: { mode: "write", temp: "[redacted path]" },
      });
    } finally {
      await session.close();
    }
    await expect(KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand(),
      environment: { ...process.env, TEMP: "C:\\host-ipc-temp", TMP: "C:\\host-ipc-temp" },
      extraEnvironment: { TEMP: "C:\\private-temp" },
    })).rejects.toThrow(/not allowlisted/iu);
  });

  it("requires a separate canonical root before enabling reviewed write tools", async () => {
    const { workspace, project, canonical } = await roots();
    await expect(
      KicadMcpSession.connect({
        workspaceRoot: workspace,
        projectRoot: project,
        mode: "write",
        command: fakeCommand(),
      }),
    ).rejects.toThrow(/isolated working copy/iu);

    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      mode: "write",
      isolatedWorkingCopy: { canonicalProjectRoot: canonical },
      command: fakeCommand(),
    });
    try {
      expect(session.identity.launch).toMatchObject({
        profile: "full", mode: "write", transport: "stdio",
        argumentCount: fakeCommand().args.length + 6,
      });
      expect(session.listTools()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "kicad_get_version", permission: "read" }),
          expect.objectContaining({ name: "sch_apply_plan", permission: "write" }),
        ]),
      );
      await expect(session.callTool("sch_apply_plan", {})).resolves.toMatchObject({
        structuredContent: { ok: true, mode: "write" },
      });
    } finally {
      await session.close();
    }
  });

  it("admits the captured qualified footprint sync descriptor and dispatches its exact arguments", async () => {
    // Captured with the actual FastMCP registration and Node MCP client decoder;
    // the fixture preserves the complete Tool descriptor, including description whitespace.
    expect(createHash("sha256").update(canonicalJson(qualifiedFootprintSyncTool), "utf8").digest("hex"))
      .toBe("4cd5981b622b80ff90341b67ebe08fea9c8e317d41530fe496583eed2d38a2b3");
    const { workspace, project, canonical } = await roots();
    const fixture = await livePcbFixture(project, [], { syncTool: qualifiedFootprintSyncTool });
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace, projectRoot: project, mode: "write",
      isolatedWorkingCopy: { canonicalProjectRoot: canonical }, command: fixture.command,
      requiredTools: [qualifiedFootprintSyncTool.name],
    });
    const args = { auto_place: false, replace_mismatched: true };
    try {
      expect(session.supportsQualifiedFootprintIdentitySync()).toBe(true);
      await expect(session.callTool(qualifiedFootprintSyncTool.name, args)).resolves.toEqual({
        content: [{ type: "text", text: JSON.stringify({ schemaVersion: "evleda.kicad-mcp-result.v1", category: "validated_structured_evidence" }) }],
        structuredContent: { result: "fake qualified footprint sync accepted" },
      });
      expect((await readFile(fixture.callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)))
        .toEqual([{ name: qualifiedFootprintSyncTool.name, arguments: args }]);
      expect(session.supportsQualifiedFootprintIdentitySync()).toBe(true);
    } finally { await session.close(); }
    expect(session.supportsQualifiedFootprintIdentitySync()).toBe(false);
  });

  it.each([
    ["marker version", { _meta: { evledaQualifiedFootprintIdentitySync: "evleda.kicad-qualified-footprint-identity-sync.v0" } }],
    ["extra metadata", { _meta: { ...qualifiedFootprintSyncTool._meta, extra: true } }],
    ["input schema", { inputSchema: { ...qualifiedFootprintSyncTool.inputSchema, additionalProperties: false } }],
    ["output schema", { outputSchema: { ...qualifiedFootprintSyncTool.outputSchema, additionalProperties: false } }],
    ["idempotent annotation", { annotations: { idempotentHint: true } }],
    ["extra read-only annotation", { annotations: { ...qualifiedFootprintSyncTool.annotations, readOnlyHint: false } }],
    ["description", { description: "changed qualified footprint sync description" }],
    ["description trailing newline", { description: `${qualifiedFootprintSyncTool.description}\n` }],
  ] as const)("rejects qualified footprint sync %s tampering before any tool dispatch", async (_label, override) => {
    const { workspace, project } = await roots();
    const fixture = await livePcbFixture(project, [], { syncTool: { ...qualifiedFootprintSyncTool, ...override } });
    for (const mode of ["readonly", "write"] as const) {
      await expect(KicadMcpSession.connect({
        workspaceRoot: workspace, projectRoot: project, mode,
        ...(mode === "write" ? { freshProject: true } : {}), command: fixture.command,
      })).rejects.toThrow(/footprint identity sync claims a mismatched qualified tool contract/iu);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["readonly", "write"] as const)("keeps an unmarked old runtime readable in %s mode while footprint sync remains unsupported", async (mode) => {
    const { workspace, project } = await roots();
    const { _meta: _qualification, ...unqualifiedTool } = qualifiedFootprintSyncTool;
    const fixture = await livePcbFixture(project, [], { syncTool: unqualifiedTool });
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace, projectRoot: project, mode, command: fixture.command,
      ...(mode === "write" ? { freshProject: true, requiredTools: [qualifiedFootprintSyncTool.name] } : {}),
    });
    try {
      expect(session.supportsQualifiedFootprintIdentitySync()).toBe(false);
      await expect(session.callTool(qualifiedFootprintSyncTool.name, { replace_mismatched: true })).rejects.toThrow(
        mode === "write" ? /requires the qualified full-footprint-library-identity writer/iu : /not allowed in readonly mode/iu,
      );
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(session.callTool("pcb_get_board_as_string")).resolves.toMatchObject({
        structuredContent: { result: "configured board source is not live authority" },
      });
      expect((await readFile(fixture.callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)))
        .toEqual([{ name: "pcb_get_board_as_string", arguments: {} }]);
      expect(session.supportsQualifiedFootprintIdentitySync()).toBe(false);
    } finally { await session.close(); }
  });

  it("keeps the qualified footprint sync writer behind readonly and deferred project-binding gates", async () => {
    const { workspace, project } = await roots();
    const fixture = await livePcbFixture(project, [], { syncTool: qualifiedFootprintSyncTool });
    await expect(KicadMcpSession.connect({
      workspaceRoot: workspace, projectRoot: project, command: fixture.command,
      requiredTools: [qualifiedFootprintSyncTool.name],
    })).rejects.toThrow(/capability\/allowlist mismatch/iu);
    await expect(KicadMcpSession.connect({
      workspaceRoot: workspace, projectRoot: project, command: fixture.command,
      readToolAllowlist: [qualifiedFootprintSyncTool.name],
    })).rejects.toThrow(/cannot add unreviewed tool/iu);
    const readonly = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command });
    try {
      expect(readonly.supportsQualifiedFootprintIdentitySync()).toBe(false);
      await expect(readonly.callTool(qualifiedFootprintSyncTool.name)).rejects.toThrow(/not allowed in readonly mode/iu);
    } finally { await readonly.close(); }
    const launchCwd = await mkdtemp(path.join(suiteRoot, "evleda-sync-deferred-"));
    ownedWorkspaces.add(launchCwd);
    const unbound = await KicadMcpSession.connect({
      workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true,
      launchCwd, deferProjectBinding: true, command: fixture.command,
      requiredTools: [qualifiedFootprintSyncTool.name],
    });
    try {
      expect(unbound.supportsQualifiedFootprintIdentitySync()).toBe(false);
      await expect(unbound.callTool(qualifiedFootprintSyncTool.name)).rejects.toThrow(/must be host-bound before tool calls/iu);
    } finally { await unbound.close(); }
    await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["readonly", "write"] as const)("admits the captured external power flag connectivity descriptor and preserves complete graph membership in %s mode", async mode => {
    expect(createHash("sha256").update(canonicalJson(externalPowerFlagConnectivityTool), "utf8").digest("hex"))
      .toBe("eddb2180b77bf4aa528bc9f007c5ab07cdd54dbc310d661e79c4a8fb368ad54d");
    const { workspace, project } = await roots();
    const fixture = await livePcbFixture(project, [], { graphTool: externalPowerFlagConnectivityTool });
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace, projectRoot: project, mode,
      ...(mode === "write" ? { freshProject: true } : {}),
      command: fixture.command, requiredTools: [externalPowerFlagConnectivityTool.name],
    });
    try {
      expect(session.supportsExternalPowerFlagConnectivity()).toBe(true);
      await expect(session.callTool(externalPowerFlagConnectivityTool.name)).resolves.toMatchObject({
        structuredContent: { result: "Connectivity groups (1 total):\n- Group 1: VIN | pins=#FLG01:1, J1:1 | points=2" },
      });
      expect((await readFile(fixture.callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)))
        .toEqual([{ name: externalPowerFlagConnectivityTool.name, arguments: {} }]);
    } finally { await session.close(); }
    expect(session.supportsExternalPowerFlagConnectivity()).toBe(false);
  });

  it.each([
    ["false marker", { _meta: { evledaExternalPowerFlagConnectivity: false } }],
    ["null marker", { _meta: { evledaExternalPowerFlagConnectivity: null } }],
    ["object marker", { _meta: { evledaExternalPowerFlagConnectivity: { version: 1 } } }],
    ["array marker", { _meta: { evledaExternalPowerFlagConnectivity: ["evleda.kicad-external-power-flag-connectivity.v1"] } }],
    ["wrong version", { _meta: { evledaExternalPowerFlagConnectivity: "evleda.kicad-external-power-flag-connectivity.v0" } }],
    ["extra metadata", { _meta: { ...externalPowerFlagConnectivityTool._meta, extra: true } }],
    ["input schema", { inputSchema: { ...externalPowerFlagConnectivityTool.inputSchema, additionalProperties: false } }],
    ["output schema", { outputSchema: { ...externalPowerFlagConnectivityTool.outputSchema, additionalProperties: false } }],
    ["annotation", { annotations: { ...externalPowerFlagConnectivityTool.annotations, readOnlyHint: false } }],
    ["description", { description: `${externalPowerFlagConnectivityTool.description}\n` }],
  ] as const)("rejects external power flag connectivity %s tampering before dispatch", async (_label, override) => {
    const { workspace, project } = await roots();
    const fixture = await livePcbFixture(project, [], { graphTool: { ...externalPowerFlagConnectivityTool, ...override } });
    for (const mode of ["readonly", "write"] as const) {
      await expect(KicadMcpSession.connect({
        workspaceRoot: workspace, projectRoot: project, mode,
        ...(mode === "write" ? { freshProject: true } : {}), command: fixture.command,
      })).rejects.toThrow(/external power flag connectivity claims a mismatched qualified tool contract/iu);
      await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["readonly", "write"] as const)("keeps old unmarked external power flag connectivity reads available in %s without qualified flag semantics", async mode => {
    const { workspace, project } = await roots();
    const { _meta: _qualification, ...oldGraphTool } = externalPowerFlagConnectivityTool;
    const fixture = await livePcbFixture(project, [], { graphTool: oldGraphTool });
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace, projectRoot: project, mode, command: fixture.command,
      ...(mode === "write" ? { freshProject: true } : {}),
    });
    try {
      expect(session.supportsExternalPowerFlagConnectivity()).toBe(false);
      await expect(session.callTool(externalPowerFlagConnectivityTool.name)).resolves.toMatchObject({
        structuredContent: { result: expect.stringContaining("pins=#FLG01:1, J1:1") },
      });
    } finally { await session.close(); }
  });

  it("keeps external power flag connectivity readiness separate from mutation permissions and behind project binding", async () => {
    const { workspace, project } = await roots();
    const fixture = await livePcbFixture(project, [], { graphTool: externalPowerFlagConnectivityTool });
    const readonly = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fixture.command });
    try {
      expect(readonly.supportsExternalPowerFlagConnectivity()).toBe(true);
      await expect(readonly.callTool("pcb_save")).rejects.toThrow(/not allowed in readonly mode/iu);
    }
    finally { await readonly.close(); }
    const launchCwd = await mkdtemp(path.join(suiteRoot, "evleda-flag-deferred-"));
    ownedWorkspaces.add(launchCwd);
    const unbound = await KicadMcpSession.connect({
      workspaceRoot: workspace, projectRoot: project, mode: "write", freshProject: true,
      launchCwd, deferProjectBinding: true, command: fixture.command,
      requiredTools: [externalPowerFlagConnectivityTool.name],
    });
    try {
      expect(unbound.supportsExternalPowerFlagConnectivity()).toBe(false);
      await expect(unbound.callTool(externalPowerFlagConnectivityTool.name)).rejects.toThrow(/must be host-bound before tool calls/iu);
    } finally { await unbound.close(); }
    await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires graph read authority for external power flag connectivity capability", async () => {
    const { workspace, project } = await roots();
    const fixture = await livePcbFixture(project, [], { graphTool: externalPowerFlagConnectivityTool });
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace, projectRoot: project, command: fixture.command,
      readToolAllowlist: ["kicad_get_project_info"],
    });
    try {
      expect(session.supportsExternalPowerFlagConnectivity()).toBe(false);
      await expect(session.callTool(externalPowerFlagConnectivityTool.name)).rejects.toThrow(/not allowed in readonly mode/iu);
    } finally { await session.close(); }
    await expect(readFile(fixture.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reserves profile, mode, and project selection for the controller", async () => {
    const { workspace, project } = await roots();
    await expect(KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: { command: process.execPath, args: ["--mode", "write"] },
    })).rejects.toThrow(/controller-managed launch options/iu);
  });

  it("rejects a connected catalog when caller-required capabilities are unavailable", async () => {
    const { workspace, project, canonical } = await roots();
    await expect(KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      mode: "write",
      isolatedWorkingCopy: { canonicalProjectRoot: canonical },
      command: fakeCommand(),
      requiredTools: ["pcb_get_tracks", "pcb_add_track", "pcb_add_via", "pcb_save"],
    })).rejects.toThrow(/capability\/allowlist mismatch.*pcb_get_tracks \(not advertised\).*pcb_save \(not advertised\)/iu);
  });

  it("admits every reviewed fresh edit plus host-only recovery reads in write mode", async () => {
    const { workspace, project } = await roots();
    const required = [
      "kicad_set_project", "sch_add_symbol", "sch_modify_property", "lib_assign_footprint",
      "sch_route_wire_between_pins", "sch_add_power_symbol", "sch_move_symbol", "sch_add_label",
      "sch_add_missing_junctions", "kicad_get_project_info", "pcb_get_board_as_string",
    ];
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      mode: "write",
      freshProject: true,
      command: fakeCommand("fresh"),
      requiredTools: required,
    });
    try {
      const permissions = new Map(session.listTools().map((tool) => [tool.name, tool.permission]));
      expect(permissions.get("sch_add_symbol")).toBe("write");
      expect(permissions.get("sch_add_missing_junctions")).toBe("write");
      expect(permissions.get("kicad_get_project_info")).toBe("read");
      expect(permissions.get("pcb_get_board_as_string")).toBe("read");
    } finally {
      await session.close();
    }
  });

  it("identifies a missing fresh sidecar capability as an allowlist mismatch", async () => {
    const { workspace, project } = await roots();
    await expect(KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      mode: "write",
      freshProject: true,
      command: fakeCommand("fresh-missing"),
      requiredTools: ["sch_add_symbol", "pcb_get_board_as_string"],
    })).rejects.toThrow(/capability\/allowlist mismatch.*sch_add_symbol \(not advertised\)/iu);
  });

  it("walks every tool page, preserves opaque cursors, and enforces discovery caps", async () => {
    const { workspace, project } = await roots();
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand("paginated"),
      maxToolPages: 3,
      maxTools: 3,
    });
    try {
      expect(session.listTools().map((tool) => tool.name)).toEqual([
        "kicad_get_version",
        "kicad_get_project_info",
      ]);
      expect(session.identity.toolDiscovery).toEqual({
        pageCount: 2,
        toolCount: 2,
        pageCursorIdentities: [null, expect.stringMatching(/^[a-f0-9]{64}$/u)],
      });
    } finally {
      await session.close();
    }

    await expect(
      KicadMcpSession.connect({
        workspaceRoot: workspace,
        projectRoot: project,
        command: fakeCommand("paginated"),
        maxToolPages: 1,
      }),
    ).rejects.toThrow(/page limit/iu);
    await expect(
      KicadMcpSession.connect({
        workspaceRoot: workspace,
        projectRoot: project,
        command: fakeCommand("paginated"),
        maxTools: 1,
      }),
    ).rejects.toThrow(/tool limit/iu);
  });

  it.each([
    ["duplicate", /duplicate tool name/iu],
    ["conflict", /conflicting tool name/iu],
    ["cycle", /repeated cursor/iu],
  ] as const)("rejects non-convergent %s discovery", async (mode, expected) => {
    const { workspace, project } = await roots();
    await expect(
      KicadMcpSession.connect({
        workspaceRoot: workspace,
        projectRoot: project,
        command: fakeCommand(mode),
      }),
    ).rejects.toThrow(expected);
  });

  it("rejects launcher identity mismatches before spawning", async () => {
    const { workspace, project } = await roots();
    const actual = await createKicadMcpExpectedExecutableIdentity(process.execPath);
    await expect(
      KicadMcpSession.connect({
        workspaceRoot: workspace,
        projectRoot: project,
        command: fakeCommand(),
        expectedLauncherIdentity: {
          ...actual,
          sha256: "0".repeat(64),
        },
      }),
    ).rejects.toThrow(/expected.*identity/iu);
  });

  it("rejects a same-byte launcher at any path other than the exact pin", async () => {
    const { workspace, project } = await roots();
    const alternate = path.join(workspace, process.platform === "win32" ? "alternate.exe" : "alternate");
    await copyFile(process.execPath, alternate);
    if (process.platform !== "win32") await chmod(alternate, 0o700);
    const expected = await createKicadMcpExpectedExecutableIdentity(process.execPath);
    await expect(RawKicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: { ...fakeCommand(), command: alternate },
      expectedLauncherIdentity: expected,
    })).rejects.toThrow(/expected executable identity/iu);
  });

  it("requires an absolute pinned native launcher and rejects shell fallbacks", async () => {
    const { workspace, project } = await roots();
    await expect(RawKicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand(),
    })).rejects.toThrow(/explicit expected path and byte identity/iu);
    const expected = await createKicadMcpExpectedExecutableIdentity(process.execPath);
    await expect(RawKicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand("single", true),
      expectedLauncherIdentity: expected,
      environment: { PATH: path.dirname(process.execPath), PATHEXT: ".EXE;.BAT;.CMD" },
    })).rejects.toThrow(/explicit absolute executable path/iu);
    const shell = path.join(workspace, "sidecar.cmd");
    await writeFile(shell, "@exit /b 0\r\n", "utf8");
    await expect(RawKicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: { command: shell, args: [] },
      expectedLauncherIdentity: { ...expected, path: shell },
    })).rejects.toThrow(/shell \.bat\/\.cmd fallbacks are forbidden/iu);
  });

  it("converts raw sidecar failures into closed categorical evidence", async () => {
    const { workspace, project } = await roots();
    const session = await KicadMcpSession.connect({ workspaceRoot: workspace, projectRoot: project, command: fakeCommand() });
    const pid = session.identity.pid;
    let caught: unknown;
    try { await session.callTool("kicad_get_version", { rawSecretFailure: true }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("sk-sidecar-secret");
    expect(String(caught)).not.toContain("C:/private");
    expect(JSON.stringify(caught)).not.toContain("sk-sidecar-secret");
    expect(session.stderr).not.toHaveProperty("text");
    expect(session.identity.pid).toBe(pid);
  });

  it("fails closed when stderr crosses its configured byte limit", async () => {
    const { workspace, project } = await roots();
    await expect(
      KicadMcpSession.connect({
        workspaceRoot: workspace,
        projectRoot: project,
        command: fakeCommand(),
        maxStderrBytes: 32,
      }),
    ).rejects.toBeInstanceOf(KicadMcpOutputLimitError);

    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand(),
      maxStderrBytes: 256,
    });
    await expect(
      session.callTool("kicad_get_version", { stderrFlood: true }),
    ).rejects.toBeInstanceOf(KicadMcpOutputLimitError);
    await expect(session.callTool("kicad_get_version")).rejects.toThrow(/session is closed/iu);
  });

  it("closes the session when structured output violates the discovered schema", async () => {
    const { workspace, project } = await roots();
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand(),
    });

    await expect(
      session.callTool("kicad_get_version", { invalidOutput: true }),
    ).rejects.toThrow(/did not complete safely/iu);
    await expect(session.callTool("kicad_get_version")).rejects.toThrow(/session is closed/iu);
  });

  it("times out unanswered calls and fails the session closed", async () => {
    const { workspace, project } = await roots();
    const session = await KicadMcpSession.connect({
      workspaceRoot: workspace,
      projectRoot: project,
      command: fakeCommand(),
    });

    await expect(
      session.callTool("kicad_get_version", { hang: true }, { timeoutMs: 50 }),
    ).rejects.toThrow(/did not complete safely/iu);
    await expect(session.callTool("kicad_get_version")).rejects.toThrow(/session is closed/iu);
  });
});

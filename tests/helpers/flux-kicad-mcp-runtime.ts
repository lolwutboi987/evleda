import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalIdentity, canonicalJson } from "../../src/core/canonical.js";
import type { CanonicalIdentity } from "../../src/domain/types.js";
import {
  KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
  KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS,
  KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION,
  KICAD_MCP_SESSION_SEMANTIC_IDENTITY_SCHEMA_VERSION,
  type KicadMcpInspectionIpcSocketBinding,
  type KicadMcpRuntimeBridge,
  type KicadMcpSession,
  type KicadMcpSessionOptions,
} from "../../src/integrations/kicad-mcp-session.js";

interface SocketState {
  readonly runBindingIdentity: CanonicalIdentity;
  count: number;
  active: boolean;
  released: boolean;
}

export interface FakeFluxKicadMcpRuntime {
  readonly runtime: KicadMcpRuntimeBridge;
  readonly connectionCount: () => number;
  readonly releasedCount: () => number;
  readonly setCurrent: (value: boolean) => void;
  readonly setOnAllocate: (value: (() => void | Promise<void>) | undefined) => void;
  readonly setReadSemanticVersion: (value: number) => void;
  readonly setOnSessionClosed: (value: (() => void | Promise<void>) | undefined) => void;
  readonly setOnConnect: (value: ((mode: "readonly" | "write") => void | Promise<void>) | undefined) => void;
}

export function createFakeFluxKicadMcpRuntime(): FakeFluxKicadMcpRuntime {
  const identity = canonicalIdentity({ fixture: "runtime" }, "evleda.kicad-mcp-runtime.v1");
  const inspectionBridgeIdentity = canonicalIdentity({ identity, mode: "readonly" }, "evleda.kicad-mcp-inspection-bridge.v2");
  const executionBridgeIdentity = canonicalIdentity({ identity, mode: "write" }, "evleda.kicad-mcp-execution-bridge.v1");
  const sockets = new WeakMap<KicadMcpInspectionIpcSocketBinding, SocketState>();
  let current = true;
  let allocations = 0;
  let totalConnections = 0;
  let totalReleased = 0;
  let authorityAllocations = 0;
  let onAllocate: (() => void | Promise<void>) | undefined;
  let readSemanticVersion = 1;
  let onSessionClosed: (() => void | Promise<void>) | undefined;
  let onConnect: ((mode: "readonly" | "write") => void | Promise<void>) | undefined;

  const assertCurrent = async (): Promise<void> => {
    if (!current) throw new Error("KiCad MCP runtime changed");
  };
  const stateFor = (binding: KicadMcpInspectionIpcSocketBinding, runBindingIdentity: CanonicalIdentity): SocketState => {
    const state = sockets.get(binding);
    if (state === undefined || state.released || canonicalJson(state.runBindingIdentity) !== canonicalJson(runBindingIdentity)) {
      throw new Error("KiCad IPC socket binding is unavailable");
    }
    return state;
  };
  const assertIpcSocket: KicadMcpRuntimeBridge["assertIpcSocket"] = async (binding, runBindingIdentity) => {
    await assertCurrent();
    const state = stateFor(binding, runBindingIdentity);
    return Object.freeze({ bindingIdentity: binding.identity, remainingConnections: KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS - state.count, active: state.active });
  };
  const allocateIpcSocket: KicadMcpRuntimeBridge["allocateIpcSocket"] = async ({ runBindingIdentity }) => {
    await assertCurrent();
    allocations += 1;
    const endpoint = `ipc://${path.join(tmpdir(), `f-ipc-${allocations}`, "kicad", "api.sock")}`;
    const socketIdentity = canonicalIdentity({ allocation: allocations, runBindingIdentity }, "evleda.kicad-api-socket-binding.v1");
    const binding = Object.freeze({ endpoint, identity: socketIdentity });
    sockets.set(binding, { runBindingIdentity, count: 0, active: false, released: false });
    await onAllocate?.();
    return binding;
  };
  const releaseIpcSocket: KicadMcpRuntimeBridge["releaseIpcSocket"] = async (binding, runBindingIdentity) => {
    const state = sockets.get(binding);
    if (state === undefined || canonicalJson(state.runBindingIdentity) !== canonicalJson(runBindingIdentity)) throw new Error("KiCad IPC socket binding is unavailable");
    if (state.released) return "released";
    if (state.active) return "deferred_active";
    state.released = true;
    totalReleased += 1;
    return "released";
  };
  const bindSession: KicadMcpRuntimeBridge["bindSession"] = async ({ runBindingIdentity, ipcSocket, mode, requiredTools, roots }) => {
    const state = stateFor(ipcSocket, runBindingIdentity);
    const tools = Object.freeze([...requiredTools].sort());
    const semanticAuthorityIdentity = canonicalIdentity({
      inspectionBridgeIdentity,
      executionBridgeIdentity,
      ipcSocketIdentity: ipcSocket.identity,
      runBindingIdentity,
      mode,
      requiredTools: tools,
      roots,
    }, "evleda.kicad-mcp-session-semantic-authority.v1");
    authorityAllocations += 1;
    const authorityIdentity = canonicalIdentity({ semanticAuthorityIdentity, allocation: authorityAllocations }, "evleda.kicad-mcp-session-authority.v1");
    const stableSessionSemanticIdentity = canonicalIdentity({ semanticAuthorityIdentity, mode, ipcSocketIdentity: ipcSocket.identity }, KICAD_MCP_SESSION_SEMANTIC_IDENTITY_SCHEMA_VERSION);
    let authorityConnected = false;
    let authorityDisposed = false;
    return Object.freeze({
      identity: authorityIdentity,
      semanticIdentity: semanticAuthorityIdentity,
      connect: async (options: KicadMcpSessionOptions): Promise<KicadMcpSession> => {
        await assertCurrent();
        if (authorityDisposed || authorityConnected || state.active || state.count >= KICAD_MCP_IPC_SOCKET_MAX_CONNECTIONS || options.mode !== mode
            || canonicalJson([...(options.requiredTools ?? [])].sort()) !== canonicalJson(tools)) {
          throw new Error("KiCad MCP fake connection authority rejected");
        }
        authorityConnected = true;
        state.active = true;
        state.count += 1;
        totalConnections += 1;
        await onConnect?.(mode);
        const sessionSemanticIdentity = stableSessionSemanticIdentity;
        const sessionReceiptIdentity = canonicalIdentity({
          sessionSemanticIdentity,
          connection: state.count,
        }, KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION);
        let closed = false;
        return {
          identity: {
            sessionSemanticIdentity,
            mode,
            server: { name: "kicad-mcp-pro", version: "1.29.1", authenticated: true },
            sidecar: { distribution: "kicad-mcp-pro", version: "3.33.3", auditedCommit: "1".repeat(40), publishedDistributionSha256: [] },
            launch: {
              sessionAuthorityIdentity: authorityIdentity,
              sessionSemanticAuthorityIdentity: semanticAuthorityIdentity,
              ipcSocketIdentity: ipcSocket.identity,
              workingDirectoryPathIdentity: `cwd-${state.count}`,
              rootProcessIncarnationIdentity: canonicalIdentity({ pid: 10_000 + state.count, launchObservedNs: String(state.count) }, "evleda.test-process-incarnation.v1"),
            },
            sessionReceiptIdentity,
          },
          callTool: async (tool: string) => ({ structuredContent: { tool, count: 1, semanticVersion: readSemanticVersion } }),
          close: async () => { if (!closed) { closed = true; state.active = false; await onSessionClosed?.(); } },
        } as unknown as KicadMcpSession;
      },
      disposeUnused: async () => {
        if (authorityConnected) return "already_connected" as const;
        authorityDisposed = true;
        return "disposed" as const;
      },
    });
  };
  const connect: KicadMcpRuntimeBridge["connect"] = async (request) => await (await bindSession({
    runBindingIdentity: request.runBindingIdentity,
    ipcSocket: request.ipcSocket,
    mode: "readonly",
    requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
    roots: { workspaceRoot: request.workspaceRoot, projectRoot: request.projectRoot, outputRoot: request.outputRoot },
  })).connect({
    workspaceRoot: request.workspaceRoot,
    projectRoot: request.projectRoot,
    outputRoot: request.outputRoot,
    mode: "readonly",
    requiredTools: KICAD_MCP_INSPECTION_TOOL_ALLOWLIST,
  });
  const runtime: KicadMcpRuntimeBridge = Object.freeze({
    identity,
    inspectionBridgeIdentity,
    executionBridgeIdentity,
    allocateIpcSocket,
    assertIpcSocket,
    getEditorLaunchContext: async (binding: KicadMcpInspectionIpcSocketBinding, runBindingIdentity: CanonicalIdentity) => {
      stateFor(binding, runBindingIdentity);
      const tempRoot = path.dirname(path.dirname(binding.endpoint.slice("ipc://".length)));
      return Object.freeze({ endpoint: binding.endpoint, tempRoot, configRoot: path.join(tempRoot, "config"), prepareLaunch: assertCurrent, observeExit: () => undefined });
    },
    releaseIpcSocket,
    bindSession,
    connect,
    assertCurrent,
  });
  return Object.freeze({
    runtime,
    connectionCount: () => totalConnections,
    releasedCount: () => totalReleased,
    setCurrent: (value: boolean) => { current = value; },
    setOnAllocate: (value: (() => void | Promise<void>) | undefined) => { onAllocate = value; },
    setReadSemanticVersion: (value: number) => { readSemanticVersion = value; },
    setOnSessionClosed: (value: (() => void | Promise<void>) | undefined) => { onSessionClosed = value; },
    setOnConnect: (value: ((mode: "readonly" | "write") => void | Promise<void>) | undefined) => { onConnect = value; },
  });
}

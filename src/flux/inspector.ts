import { KicadMcpSession } from "../integrations/kicad-mcp-session.js";
import { hardenPortableValue, validateCanonicalIdentity } from "../core/portable-artifact.js";
import type { FluxCanonicalIdentityDto } from "./contracts.js";

const TOOL_NAMES = Object.freeze([
  "pcb_get_board_summary",
  "pcb_get_design_rules",
  "pcb_get_footprints",
  "pcb_get_tracks",
  "pcb_get_vias",
  "pcb_get_zones",
] as const);

export type FluxInspectionToolName = (typeof TOOL_NAMES)[number];

export interface FluxInspectionToolDto {
  readonly tool: FluxInspectionToolName;
  readonly value: unknown;
}

export const FLUX_INSPECTION_CONNECTION_LIMIT = 8 as const;
export interface FluxInspectionAuthorityDto {
  readonly runId: string;
  readonly inspectionBridgeIdentity: FluxCanonicalIdentityDto;
  readonly executionBridgeIdentity: FluxCanonicalIdentityDto;
  readonly ipcSocketIdentity: FluxCanonicalIdentityDto;
  readonly writeSessionAuthorityIdentity: FluxCanonicalIdentityDto;
  readonly connectionBudget: Readonly<{ readonly used: number; readonly remaining: number; readonly limit: typeof FLUX_INSPECTION_CONNECTION_LIMIT }>;
}

export interface FluxInspectorBusySnapshot extends FluxInspectionAuthorityDto {
  readonly state: "busy";
  readonly busy: true;
  readonly completedTools: number;
  readonly totalTools: number;
  readonly activeTool: FluxInspectionToolName;
}

export interface FluxInspectorReadySnapshot extends FluxInspectionAuthorityDto {
  readonly state: "ready";
  readonly busy: false;
  readonly completedTools: number;
  readonly totalTools: number;
  readonly capturedAt: string;
  readonly boardSummary: FluxInspectionToolDto;
  readonly rules: FluxInspectionToolDto;
  readonly footprints: FluxInspectionToolDto;
  readonly tracks: FluxInspectionToolDto;
  readonly vias: FluxInspectionToolDto;
  readonly zones: FluxInspectionToolDto;
}

export type FluxInspectorSnapshot =
  | (FluxInspectionAuthorityDto & Readonly<{ readonly state: "idle"; readonly busy: false; readonly completedTools: 0; readonly totalTools: number }>)
  | FluxInspectorBusySnapshot
  | FluxInspectorReadySnapshot;

export type FluxInspectorObserver = (snapshot: FluxInspectorSnapshot) => void | Promise<void>;

export class FluxInspectorError extends Error {
  override readonly name = "FluxInspectorError";
}

const MAX_DEPTH = 5;
const MAX_KEYS = 32;
const MAX_ITEMS = 24;
const MAX_STRING_CHARS = 768;
const PATH_KEY = /(?:path|file|directory|folder|root|workspace|project|output|destination)/iu;
const PATH_LIKE_VALUE = /(?:[\\/]|^~|^file:)/iu;

const freeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
};

const safeString = (value: string): string => {
  if (PATH_LIKE_VALUE.test(value.trim())) return "[redacted path]";
  return value.length <= MAX_STRING_CHARS ? value : `${value.slice(0, MAX_STRING_CHARS - 15)} [truncated]`;
};

/** Bound untrusted MCP output and ensure paths never enter a UI DTO. */
function boundedValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return safeString(value);
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return Object.freeze(value.slice(0, MAX_ITEMS).map((item) => boundedValue(item, depth + 1)));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      if (!PATH_KEY.test(key)) result[key] = boundedValue(item, depth + 1);
    }
    return freeze(result);
  }
  return String(value);
}

function resultValue(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return boundedValue(result);
  const record = result as { structuredContent?: unknown; content?: unknown };
  if (record.structuredContent !== undefined) return boundedValue(record.structuredContent);
  if (typeof record.content === "string") {
    try { return boundedValue(JSON.parse(record.content) as unknown); }
    catch { return boundedValue(record.content); }
  }
  return boundedValue(record.content ?? null);
}

const SAFE_ID = /^[a-z][a-z0-9_-]{0,127}$/u;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\b(?:password|authorization|cookie)\s*[:=])/iu;
const LOCAL_PATH = /(?:^~[\\/]|^[A-Za-z]:[\\/]|^\\\\|^file:|^\/(?:Users|home|tmp|var|etc|opt|private)\/)/iu;
const authorityKeys = ["runId", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "connectionBudget"] as const;
const exactKeys = (record: Record<string, unknown>, required: readonly string[]): void => {
  if (Object.keys(record).length !== required.length || required.some((key) => !Object.hasOwn(record, key))) throw new FluxInspectorError("Flux inspection snapshot has missing or unknown fields.");
};
const plainRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FluxInspectorError("Flux inspection snapshot is malformed.");
  return value as Record<string, unknown>;
};
const authorityFromRecord = (record: Record<string, unknown>): FluxInspectionAuthorityDto => {
  if (typeof record.runId !== "string" || !SAFE_ID.test(record.runId)) throw new FluxInspectorError("Flux inspection run binding is invalid.");
  const inspectionBridgeIdentity = validateCanonicalIdentity(record.inspectionBridgeIdentity, "inspectionBridgeIdentity");
  const executionBridgeIdentity = validateCanonicalIdentity(record.executionBridgeIdentity, "executionBridgeIdentity");
  const ipcSocketIdentity = validateCanonicalIdentity(record.ipcSocketIdentity, "ipcSocketIdentity");
  const writeSessionAuthorityIdentity = validateCanonicalIdentity(record.writeSessionAuthorityIdentity, "writeSessionAuthorityIdentity");
  if (inspectionBridgeIdentity.schemaVersion !== "evleda.kicad-mcp-inspection-bridge.v2" || executionBridgeIdentity.schemaVersion !== "evleda.kicad-mcp-execution-bridge.v1" ||
    ipcSocketIdentity.schemaVersion !== "evleda.kicad-api-socket-binding.v1" || writeSessionAuthorityIdentity.schemaVersion !== "evleda.kicad-mcp-session-authority.v1") throw new FluxInspectorError("Flux inspection bridge, socket, or write-session authority schema is invalid.");
  const budget = plainRecord(record.connectionBudget); exactKeys(budget, ["used", "remaining", "limit"]);
  if (!Number.isSafeInteger(budget.used) || !Number.isSafeInteger(budget.remaining) || budget.limit !== FLUX_INSPECTION_CONNECTION_LIMIT || (budget.used as number) < 0 || (budget.remaining as number) < 0 || (budget.used as number) + (budget.remaining as number) !== FLUX_INSPECTION_CONNECTION_LIMIT) throw new FluxInspectorError("Flux inspection connection budget is invalid.");
  return freeze({ runId: record.runId, inspectionBridgeIdentity, executionBridgeIdentity, ipcSocketIdentity, writeSessionAuthorityIdentity,
    connectionBudget: { used: budget.used as number, remaining: budget.remaining as number, limit: FLUX_INSPECTION_CONNECTION_LIMIT } });
};
const parseInspectionAuthority = (value: unknown): FluxInspectionAuthorityDto => {
  const record = plainRecord(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 12, maxKeyBytes: 64, maxStringBytes: 256 }));
  exactKeys(record, authorityKeys); return authorityFromRecord(record);
};
const assertPublicInspectionValue = (value: unknown, key = "", depth = 0): void => {
  if (depth > 8) throw new FluxInspectorError("Flux inspection snapshot exceeds its public depth bound.");
  if (typeof value === "string") { if (SECRET_VALUE.test(value) || LOCAL_PATH.test(value.trim())) throw new FluxInspectorError("Flux inspection snapshot contains unsafe private text."); return; }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) { for (const item of value) assertPublicInspectionValue(item, key, depth + 1); return; }
  const record = plainRecord(value);
  for (const [childKey, child] of Object.entries(record)) {
    if (PATH_KEY.test(childKey) || /(?:password|authorization|cookie|credential|privatekey|rawprovidertext)/iu.test(childKey.replaceAll(/[_-]/gu, ""))) throw new FluxInspectorError("Flux inspection snapshot contains an unsafe private field.");
    assertPublicInspectionValue(child, childKey, depth + 1);
  }
};

export const projectFluxInspectorSnapshot = (value: unknown): FluxInspectorSnapshot => {
  let safe: unknown;
  try { safe = hardenPortableValue(value, { maxBytes: 2 * 1024 * 1024, maxDepth: 10, maxNodes: 100_000, maxArrayLength: 4_096, maxOwnKeys: 64, maxKeyBytes: 128, maxStringBytes: 16 * 1024 }); }
  catch { throw new FluxInspectorError("Flux inspection snapshot is not bounded plain data."); }
  const record = plainRecord(safe); const common = [...authorityKeys, "state", "busy", "completedTools", "totalTools"];
  if (!Number.isSafeInteger(record.completedTools) || record.totalTools !== TOOL_NAMES.length || (record.completedTools as number) < 0 || (record.completedTools as number) > TOOL_NAMES.length) throw new FluxInspectorError("Flux inspection progress is invalid.");
  const authority = authorityFromRecord(record);
  if (record.state === "idle") {
    exactKeys(record, common); if (record.busy !== false || record.completedTools !== 0) throw new FluxInspectorError("Flux idle inspection snapshot is invalid.");
    return freeze({ ...authority, state: "idle", busy: false, completedTools: 0, totalTools: TOOL_NAMES.length });
  }
  if (record.state === "busy") {
    exactKeys(record, [...common, "activeTool"]); if (record.busy !== true || typeof record.activeTool !== "string" || !TOOL_NAMES.includes(record.activeTool as FluxInspectionToolName)) throw new FluxInspectorError("Flux busy inspection snapshot is invalid.");
    return freeze({ ...authority, state: "busy", busy: true, completedTools: record.completedTools as number, totalTools: TOOL_NAMES.length, activeTool: record.activeTool as FluxInspectionToolName });
  }
  const readyKeys = [...common, "capturedAt", "boardSummary", "rules", "footprints", "tracks", "vias", "zones"];
  exactKeys(record, readyKeys); if (record.state !== "ready" || record.busy !== false || record.completedTools !== TOOL_NAMES.length || typeof record.capturedAt !== "string" || Number.isNaN(Date.parse(record.capturedAt)) || new Date(record.capturedAt).toISOString() !== record.capturedAt) throw new FluxInspectorError("Flux ready inspection snapshot is invalid.");
  const fields = [["boardSummary", TOOL_NAMES[0]], ["rules", TOOL_NAMES[1]], ["footprints", TOOL_NAMES[2]], ["tracks", TOOL_NAMES[3]], ["vias", TOOL_NAMES[4]], ["zones", TOOL_NAMES[5]]] as const;
  const projected: Record<string, FluxInspectionToolDto> = {};
  for (const [field, expectedTool] of fields) { const item = plainRecord(record[field]); exactKeys(item, ["tool", "value"]); if (item.tool !== expectedTool) throw new FluxInspectorError("Flux inspection tool binding is invalid."); assertPublicInspectionValue(item.value); projected[field] = freeze({ tool: expectedTool, value: item.value }); }
  return freeze({ ...authority, state: "ready", busy: false, completedTools: TOOL_NAMES.length, totalTools: TOOL_NAMES.length, capturedAt: record.capturedAt,
    boardSummary: projected.boardSummary!, rules: projected.rules!, footprints: projected.footprints!, tracks: projected.tracks!, vias: projected.vias!, zones: projected.zones! });
};

/**
 * Read-only MCP board inspection for Flux. It requires a session that was
 * connected in readonly mode and only calls the six fixed inspection tools.
 */
export class FluxInspector {
  readonly session: KicadMcpSession;
  readonly #authority: FluxInspectionAuthorityDto;
  #snapshot: FluxInspectorSnapshot;

  constructor(session: KicadMcpSession, authority: FluxInspectionAuthorityDto) {
    this.session = session;
    this.#authority = parseInspectionAuthority(authority);
    this.#snapshot = freeze({ ...this.#authority, state: "idle", busy: false, completedTools: 0, totalTools: TOOL_NAMES.length });
  }

  get snapshot(): FluxInspectorSnapshot {
    return this.#snapshot;
  }

  async inspect(observer?: FluxInspectorObserver): Promise<FluxInspectorReadySnapshot> {
    if (this.session.identity.mode !== "readonly") {
      throw new FluxInspectorError("Flux inspection requires a readonly KiCad MCP session.");
    }
    const emit = async (): Promise<void> => {
      try { await observer?.(this.#snapshot); } catch { /* UI observation is best-effort. */ }
    };
    const values = new Map<FluxInspectionToolName, FluxInspectionToolDto>();
    for (const [index, tool] of TOOL_NAMES.entries()) {
      this.#snapshot = freeze({ ...this.#authority, state: "busy", busy: true, completedTools: index, totalTools: TOOL_NAMES.length, activeTool: tool });
      await emit();
      const result = await this.session.callTool(tool, {});
      values.set(tool, freeze({ tool, value: resultValue(result) }));
    }
    const ready: FluxInspectorReadySnapshot = freeze({
      ...this.#authority,
      state: "ready",
      busy: false,
      completedTools: TOOL_NAMES.length,
      totalTools: TOOL_NAMES.length,
      capturedAt: new Date().toISOString(),
      boardSummary: values.get("pcb_get_board_summary")!,
      rules: values.get("pcb_get_design_rules")!,
      footprints: values.get("pcb_get_footprints")!,
      tracks: values.get("pcb_get_tracks")!,
      vias: values.get("pcb_get_vias")!,
      zones: values.get("pcb_get_zones")!,
    });
    this.#snapshot = ready;
    await emit();
    return ready;
  }
}

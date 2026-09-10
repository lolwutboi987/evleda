import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue, validateCanonicalIdentity } from "../core/portable-artifact.js";
import { FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION, FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION } from "../harness/fresh-clearance-evidence.js";
import type { ContentIdentity } from "../domain/types.js";
import { FLUX_OPEN_CHECKPOINT_BRIDGE_SCHEMA_VERSION, FLUX_OPEN_CHECKPOINT_LEGACY_SCHEMA_VERSION, FLUX_OPEN_CHECKPOINT_PREPARED_SOURCE_SCHEMA_VERSION, FLUX_OPEN_CHECKPOINT_SCHEMA_VERSION, FLUX_OPEN_CHECKPOINT_SEMANTIC_SCHEMA_VERSION, FLUX_OPEN_CHECKPOINT_SOCKET_SCHEMA_VERSION, FLUX_OPEN_IPC_PROBE_SEMANTIC_SCHEMA_VERSION, FLUX_OPEN_PREFLIGHT_BRIDGE_SCHEMA_VERSION, FLUX_OPEN_PREFLIGHT_FAILURE_SCHEMA_VERSION, FLUX_OPEN_PREFLIGHT_LEGACY_SCHEMA_VERSION, FLUX_OPEN_PREFLIGHT_PREPARED_SOURCE_SCHEMA_VERSION, FLUX_OPEN_PREFLIGHT_SCHEMA_VERSION, FLUX_OPEN_PREFLIGHT_SEMANTIC_SCHEMA_VERSION, FLUX_OPEN_PREFLIGHT_UNCERTAIN_SCHEMA_VERSION, type FluxOpenCheckpointReceipt, type FluxOpenCheckpointReceiptV1, type FluxOpenCheckpointReceiptV2, type FluxOpenCheckpointReceiptV3, type FluxOpenCheckpointReceiptV4, type FluxOpenCheckpointReceiptV5, type FluxOpenPreflightFailureReceipt, type FluxOpenPreflightReceipt, type FluxOpenPreflightReceiptV1, type FluxOpenPreflightReceiptV2, type FluxOpenPreflightReceiptV3, type FluxOpenPreflightReceiptV4, type FluxOpenPreflightUncertainReceipt } from "./contracts.js";

const ID = /^[a-z][a-z0-9_-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const KICAD_SUITE_VERSION = /^10\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u;
const KICAD_API_SOCKET_BINDING_SCHEMA_VERSION = "evleda.kicad-api-socket-binding.v1";
const KICAD_MCP_SESSION_AUTHORITY_SCHEMA_VERSION = "evleda.kicad-mcp-session-authority.v1";
const KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION = "evleda.kicad-mcp-inspection-bridge.v2";
const KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION = "evleda.kicad-mcp-execution-bridge.v1";
const KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION = "evleda.kicad-mcp-session-receipt.v1";
const LEGACY_FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION = "evleda.fresh-netclass-semantic-authority.v1";
const LEGACY_FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION = "evleda.fresh-netclass-preparation-evidence.v1";
const FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION = "evleda.fresh-project-open-prepared-source-authority.v1";
const exact = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error("Open preflight receipt has missing or unknown fields");
};
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Open preflight receipt is malformed");
  return value as Record<string, unknown>;
};
const contentIdentity = (value: unknown): ContentIdentity => {
  const item = record(value); exact(item, ["algorithm", "digest", "size"]);
  if (item.algorithm !== "sha256" || typeof item.digest !== "string" || !DIGEST.test(item.digest) || !Number.isSafeInteger(item.size) || (item.size as number) < 1) throw new Error("Open preflight content identity is invalid");
  return Object.freeze({ algorithm: "sha256", digest: item.digest, size: item.size as number });
};

export const createFluxOpenPreflightReceipt = (payload: Omit<FluxOpenPreflightReceipt, "identity">): FluxOpenPreflightReceipt =>
  parseFluxOpenPreflightReceipt({ ...payload, identity: canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_SCHEMA_VERSION) });

export const parseFluxOpenPreflightReceipt = (value: unknown): FluxOpenPreflightReceipt => parseFluxOpenPreflightReceiptSnapshot(value);

const parseFluxOpenPreflightReceiptSnapshot = (value: unknown, legacyChildren = false): FluxOpenPreflightReceipt => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "projectId", "runId", "preparationDigest", "suiteVersion", "installationRootIdentity", "inspectionBridgeIdentity", "ipcSocketIdentity", "freshNetClassSemanticAuthorityIdentity", "freshProjectOpenPreparedSourceAuthorityIdentity", "freshNetClassPreparationEvidenceIdentity", "kicadCli", "pcbnew", "board", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_PREFLIGHT_SCHEMA_VERSION || typeof safe.projectId !== "string" || !ID.test(safe.projectId) || typeof safe.runId !== "string" || !ID.test(safe.runId) ||
    typeof safe.preparationDigest !== "string" || !DIGEST.test(safe.preparationDigest) || typeof safe.suiteVersion !== "string" || !KICAD_SUITE_VERSION.test(safe.suiteVersion)) throw new Error("Open preflight receipt is invalid");
  const ipcSocketIdentity = validateCanonicalIdentity(safe.ipcSocketIdentity, "ipcSocketIdentity");
  const inspectionBridgeIdentity = validateCanonicalIdentity(safe.inspectionBridgeIdentity, "inspectionBridgeIdentity");
  const freshNetClassSemanticAuthorityIdentity = safe.freshNetClassSemanticAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshNetClassSemanticAuthorityIdentity, "freshNetClassSemanticAuthorityIdentity");
  const freshProjectOpenPreparedSourceAuthorityIdentity = safe.freshProjectOpenPreparedSourceAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshProjectOpenPreparedSourceAuthorityIdentity, "freshProjectOpenPreparedSourceAuthorityIdentity");
  const freshNetClassPreparationEvidenceIdentity = safe.freshNetClassPreparationEvidenceIdentity === null ? null : validateCanonicalIdentity(safe.freshNetClassPreparationEvidenceIdentity, "freshNetClassPreparationEvidenceIdentity");
  if (ipcSocketIdentity.schemaVersion !== KICAD_API_SOCKET_BINDING_SCHEMA_VERSION || inspectionBridgeIdentity.schemaVersion !== KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION) throw new Error("Open preflight bridge or IPC socket identity is invalid");
  if (freshNetClassSemanticAuthorityIdentity !== null && freshNetClassSemanticAuthorityIdentity.schemaVersion !== (legacyChildren ? LEGACY_FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION : FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION)) throw new Error("Open preflight fresh net-class semantic authority is invalid");
  if (freshProjectOpenPreparedSourceAuthorityIdentity !== null && freshProjectOpenPreparedSourceAuthorityIdentity.schemaVersion !== FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION) throw new Error("Open preflight prepared-source authority is invalid");
  if (freshNetClassPreparationEvidenceIdentity !== null && freshNetClassPreparationEvidenceIdentity.schemaVersion !== (legacyChildren ? LEGACY_FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION : FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION)) throw new Error("Open preflight preparation evidence identity is invalid");
  const payload = { schemaVersion: FLUX_OPEN_PREFLIGHT_SCHEMA_VERSION, projectId: safe.projectId, runId: safe.runId, preparationDigest: safe.preparationDigest, suiteVersion: safe.suiteVersion,
    installationRootIdentity: validateCanonicalIdentity(safe.installationRootIdentity, "installationRootIdentity"), inspectionBridgeIdentity,
    ipcSocketIdentity, freshNetClassSemanticAuthorityIdentity, freshProjectOpenPreparedSourceAuthorityIdentity, freshNetClassPreparationEvidenceIdentity,
    kicadCli: contentIdentity(safe.kicadCli), pcbnew: contentIdentity(safe.pcbnew), board: contentIdentity(safe.board) };
  const identity = validateCanonicalIdentity(safe.identity, "openPreflightIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_SCHEMA_VERSION))) throw new Error("Open preflight receipt identity is invalid");
  return Object.freeze({ ...payload, identity });
};

const parseFluxOpenPreflightReceiptV4 = (value: unknown): FluxOpenPreflightReceiptV4 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "projectId", "runId", "preparationDigest", "suiteVersion", "installationRootIdentity", "inspectionBridgeIdentity", "ipcSocketIdentity", "freshNetClassSemanticAuthorityIdentity", "freshProjectOpenPreparedSourceAuthorityIdentity", "kicadCli", "pcbnew", "board", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_PREFLIGHT_PREPARED_SOURCE_SCHEMA_VERSION || typeof safe.projectId !== "string" || !ID.test(safe.projectId) || typeof safe.runId !== "string" || !ID.test(safe.runId) ||
    typeof safe.preparationDigest !== "string" || !DIGEST.test(safe.preparationDigest) || typeof safe.suiteVersion !== "string" || !KICAD_SUITE_VERSION.test(safe.suiteVersion)) throw new Error("Prepared-source Open preflight receipt is invalid");
  const ipcSocketIdentity = validateCanonicalIdentity(safe.ipcSocketIdentity, "ipcSocketIdentity"); const inspectionBridgeIdentity = validateCanonicalIdentity(safe.inspectionBridgeIdentity, "inspectionBridgeIdentity");
  const freshNetClassSemanticAuthorityIdentity = safe.freshNetClassSemanticAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshNetClassSemanticAuthorityIdentity, "freshNetClassSemanticAuthorityIdentity");
  const freshProjectOpenPreparedSourceAuthorityIdentity = safe.freshProjectOpenPreparedSourceAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshProjectOpenPreparedSourceAuthorityIdentity, "freshProjectOpenPreparedSourceAuthorityIdentity");
  if (ipcSocketIdentity.schemaVersion !== KICAD_API_SOCKET_BINDING_SCHEMA_VERSION || inspectionBridgeIdentity.schemaVersion !== KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION ||
    (freshNetClassSemanticAuthorityIdentity !== null && ![LEGACY_FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION].includes(freshNetClassSemanticAuthorityIdentity.schemaVersion)) ||
    (freshProjectOpenPreparedSourceAuthorityIdentity !== null && freshProjectOpenPreparedSourceAuthorityIdentity.schemaVersion !== FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION)) throw new Error("Prepared-source Open preflight authority is invalid");
  const payload = { schemaVersion: FLUX_OPEN_PREFLIGHT_PREPARED_SOURCE_SCHEMA_VERSION, projectId: safe.projectId, runId: safe.runId, preparationDigest: safe.preparationDigest, suiteVersion: safe.suiteVersion,
    installationRootIdentity: validateCanonicalIdentity(safe.installationRootIdentity, "installationRootIdentity"), inspectionBridgeIdentity, ipcSocketIdentity,
    freshNetClassSemanticAuthorityIdentity, freshProjectOpenPreparedSourceAuthorityIdentity,
    kicadCli: contentIdentity(safe.kicadCli), pcbnew: contentIdentity(safe.pcbnew), board: contentIdentity(safe.board) };
  const identity = validateCanonicalIdentity(safe.identity, "preparedSourceOpenPreflightIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_PREPARED_SOURCE_SCHEMA_VERSION))) throw new Error("Prepared-source Open preflight identity is invalid");
  return Object.freeze({ ...payload, identity });
};

const parseFluxOpenPreflightReceiptV3 = (value: unknown): FluxOpenPreflightReceiptV3 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "projectId", "runId", "preparationDigest", "suiteVersion", "installationRootIdentity", "inspectionBridgeIdentity", "ipcSocketIdentity", "freshNetClassSemanticAuthorityIdentity", "kicadCli", "pcbnew", "board", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_PREFLIGHT_SEMANTIC_SCHEMA_VERSION || typeof safe.projectId !== "string" || !ID.test(safe.projectId) || typeof safe.runId !== "string" || !ID.test(safe.runId) ||
    typeof safe.preparationDigest !== "string" || !DIGEST.test(safe.preparationDigest) || typeof safe.suiteVersion !== "string" || !KICAD_SUITE_VERSION.test(safe.suiteVersion)) throw new Error("Semantic Open preflight receipt is invalid");
  const ipcSocketIdentity = validateCanonicalIdentity(safe.ipcSocketIdentity, "ipcSocketIdentity");
  const inspectionBridgeIdentity = validateCanonicalIdentity(safe.inspectionBridgeIdentity, "inspectionBridgeIdentity");
  const freshNetClassSemanticAuthorityIdentity = safe.freshNetClassSemanticAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshNetClassSemanticAuthorityIdentity, "freshNetClassSemanticAuthorityIdentity");
  if (ipcSocketIdentity.schemaVersion !== KICAD_API_SOCKET_BINDING_SCHEMA_VERSION || inspectionBridgeIdentity.schemaVersion !== KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION ||
    (freshNetClassSemanticAuthorityIdentity !== null && ![LEGACY_FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION].includes(freshNetClassSemanticAuthorityIdentity.schemaVersion))) throw new Error("Semantic Open preflight authority is invalid");
  const payload = { schemaVersion: FLUX_OPEN_PREFLIGHT_SEMANTIC_SCHEMA_VERSION, projectId: safe.projectId, runId: safe.runId, preparationDigest: safe.preparationDigest, suiteVersion: safe.suiteVersion,
    installationRootIdentity: validateCanonicalIdentity(safe.installationRootIdentity, "installationRootIdentity"), inspectionBridgeIdentity, ipcSocketIdentity,
    freshNetClassSemanticAuthorityIdentity, kicadCli: contentIdentity(safe.kicadCli), pcbnew: contentIdentity(safe.pcbnew), board: contentIdentity(safe.board) };
  const identity = validateCanonicalIdentity(safe.identity, "semanticOpenPreflightIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_SEMANTIC_SCHEMA_VERSION))) throw new Error("Semantic Open preflight identity is invalid");
  return Object.freeze({ ...payload, identity });
};

const parseFluxOpenPreflightReceiptV2 = (value: unknown): FluxOpenPreflightReceiptV2 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "projectId", "runId", "preparationDigest", "suiteVersion", "installationRootIdentity", "inspectionBridgeIdentity", "ipcSocketIdentity", "kicadCli", "pcbnew", "board", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_PREFLIGHT_BRIDGE_SCHEMA_VERSION || typeof safe.projectId !== "string" || !ID.test(safe.projectId) || typeof safe.runId !== "string" || !ID.test(safe.runId) ||
    typeof safe.preparationDigest !== "string" || !DIGEST.test(safe.preparationDigest) || typeof safe.suiteVersion !== "string" || !KICAD_SUITE_VERSION.test(safe.suiteVersion)) throw new Error("Bridge-only Open preflight receipt is invalid");
  const ipcSocketIdentity = validateCanonicalIdentity(safe.ipcSocketIdentity, "ipcSocketIdentity"); const inspectionBridgeIdentity = validateCanonicalIdentity(safe.inspectionBridgeIdentity, "inspectionBridgeIdentity");
  if (ipcSocketIdentity.schemaVersion !== KICAD_API_SOCKET_BINDING_SCHEMA_VERSION || inspectionBridgeIdentity.schemaVersion !== KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION) throw new Error("Bridge-only Open preflight authority is invalid");
  const payload = { schemaVersion: FLUX_OPEN_PREFLIGHT_BRIDGE_SCHEMA_VERSION, projectId: safe.projectId, runId: safe.runId, preparationDigest: safe.preparationDigest, suiteVersion: safe.suiteVersion,
    installationRootIdentity: validateCanonicalIdentity(safe.installationRootIdentity, "installationRootIdentity"), inspectionBridgeIdentity, ipcSocketIdentity,
    kicadCli: contentIdentity(safe.kicadCli), pcbnew: contentIdentity(safe.pcbnew), board: contentIdentity(safe.board) };
  const identity = validateCanonicalIdentity(safe.identity, "bridgeOpenPreflightIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_BRIDGE_SCHEMA_VERSION))) throw new Error("Bridge-only Open preflight identity is invalid");
  return Object.freeze({ ...payload, identity });
};

const parseFluxOpenPreflightReceiptV1 = (value: unknown): FluxOpenPreflightReceiptV1 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "projectId", "runId", "preparationDigest", "suiteVersion", "installationRootIdentity", "kicadCli", "pcbnew", "board", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_PREFLIGHT_LEGACY_SCHEMA_VERSION || typeof safe.projectId !== "string" || !ID.test(safe.projectId) || typeof safe.runId !== "string" || !ID.test(safe.runId) ||
    typeof safe.preparationDigest !== "string" || !DIGEST.test(safe.preparationDigest) || typeof safe.suiteVersion !== "string" || !KICAD_SUITE_VERSION.test(safe.suiteVersion)) throw new Error("Legacy Open preflight receipt is invalid");
  const payload = { schemaVersion: FLUX_OPEN_PREFLIGHT_LEGACY_SCHEMA_VERSION, projectId: safe.projectId, runId: safe.runId, preparationDigest: safe.preparationDigest, suiteVersion: safe.suiteVersion,
    installationRootIdentity: validateCanonicalIdentity(safe.installationRootIdentity, "installationRootIdentity"), kicadCli: contentIdentity(safe.kicadCli), pcbnew: contentIdentity(safe.pcbnew), board: contentIdentity(safe.board) };
  const identity = validateCanonicalIdentity(safe.identity, "legacyOpenPreflightIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_LEGACY_SCHEMA_VERSION))) throw new Error("Legacy Open preflight receipt identity is invalid");
  return Object.freeze({ ...payload, identity });
};

export const parseFluxPersistedOpenPreflightReceipt = (value: unknown): FluxOpenPreflightReceipt | FluxOpenPreflightReceiptV1 | FluxOpenPreflightReceiptV2 | FluxOpenPreflightReceiptV3 | FluxOpenPreflightReceiptV4 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  if (safe.schemaVersion === FLUX_OPEN_PREFLIGHT_LEGACY_SCHEMA_VERSION) return parseFluxOpenPreflightReceiptV1(safe);
  if (safe.schemaVersion === FLUX_OPEN_PREFLIGHT_BRIDGE_SCHEMA_VERSION) return parseFluxOpenPreflightReceiptV2(safe);
  if (safe.schemaVersion === FLUX_OPEN_PREFLIGHT_SEMANTIC_SCHEMA_VERSION) return parseFluxOpenPreflightReceiptV3(safe);
  return safe.schemaVersion === FLUX_OPEN_PREFLIGHT_PREPARED_SOURCE_SCHEMA_VERSION ? parseFluxOpenPreflightReceiptV4(safe) : parseFluxOpenPreflightReceiptSnapshot(safe, safe.freshNetClassSemanticAuthorityIdentity !== null && record(safe.freshNetClassSemanticAuthorityIdentity).schemaVersion === LEGACY_FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
};

export const createFluxOpenPreflightFailureReceipt = (requestDigest: string, runId: string, failedAt: string): FluxOpenPreflightFailureReceipt => {
  const payload = { schemaVersion: FLUX_OPEN_PREFLIGHT_FAILURE_SCHEMA_VERSION, operation: "open_project" as const, requestDigest, runId, failedAt };
  return parseFluxOpenPreflightFailureReceipt({ ...payload, identity: canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_FAILURE_SCHEMA_VERSION) });
};

export const parseFluxOpenPreflightFailureReceipt = (value: unknown): FluxOpenPreflightFailureReceipt => {
  const safe = record(hardenPortableValue(value, { maxBytes: 4 * 1024, maxDepth: 3, maxNodes: 32, maxArrayLength: 4, maxOwnKeys: 8, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "operation", "requestDigest", "runId", "failedAt", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_PREFLIGHT_FAILURE_SCHEMA_VERSION || safe.operation !== "open_project" || typeof safe.requestDigest !== "string" || !DIGEST.test(safe.requestDigest) ||
    typeof safe.runId !== "string" || !ID.test(safe.runId) || typeof safe.failedAt !== "string" || Number.isNaN(Date.parse(safe.failedAt)) || new Date(safe.failedAt).toISOString() !== safe.failedAt) throw new Error("Open preflight failure receipt is invalid");
  const payload = { schemaVersion: FLUX_OPEN_PREFLIGHT_FAILURE_SCHEMA_VERSION, operation: "open_project" as const, requestDigest: safe.requestDigest, runId: safe.runId, failedAt: safe.failedAt };
  const identity = validateCanonicalIdentity(safe.identity, "openPreflightFailureIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_FAILURE_SCHEMA_VERSION))) throw new Error("Open preflight failure receipt identity is invalid");
  return Object.freeze({ ...payload, identity });
};

export const createFluxOpenPreflightUncertainReceipt = (requestDigest: string, runId: string, blockedAt: string): FluxOpenPreflightUncertainReceipt => {
  const payload = { schemaVersion: FLUX_OPEN_PREFLIGHT_UNCERTAIN_SCHEMA_VERSION, operation: "open_project" as const, requestDigest, runId, blockedAt };
  return parseFluxOpenPreflightUncertainReceipt({ ...payload, identity: canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_UNCERTAIN_SCHEMA_VERSION) });
};

export const parseFluxOpenPreflightUncertainReceipt = (value: unknown): FluxOpenPreflightUncertainReceipt => {
  const safe = record(hardenPortableValue(value, { maxBytes: 4 * 1024, maxDepth: 3, maxNodes: 32, maxArrayLength: 4, maxOwnKeys: 8, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "operation", "requestDigest", "runId", "blockedAt", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_PREFLIGHT_UNCERTAIN_SCHEMA_VERSION || safe.operation !== "open_project" || typeof safe.requestDigest !== "string" || !DIGEST.test(safe.requestDigest) ||
    typeof safe.runId !== "string" || !ID.test(safe.runId) || typeof safe.blockedAt !== "string" || Number.isNaN(Date.parse(safe.blockedAt)) || new Date(safe.blockedAt).toISOString() !== safe.blockedAt) throw new Error("Open preflight uncertainty receipt is invalid");
  const payload = { schemaVersion: FLUX_OPEN_PREFLIGHT_UNCERTAIN_SCHEMA_VERSION, operation: "open_project" as const, requestDigest: safe.requestDigest, runId: safe.runId, blockedAt: safe.blockedAt };
  const identity = validateCanonicalIdentity(safe.identity, "openPreflightUncertainIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_PREFLIGHT_UNCERTAIN_SCHEMA_VERSION))) throw new Error("Open preflight uncertainty receipt identity is invalid");
  return Object.freeze({ ...payload, identity });
};

export const createFluxOpenCheckpointReceipt = (payload: Omit<FluxOpenCheckpointReceipt, "identity">): FluxOpenCheckpointReceipt =>
  parseFluxOpenCheckpointReceipt({ ...payload, identity: canonicalIdentity(payload, FLUX_OPEN_CHECKPOINT_SCHEMA_VERSION) });

export const parseFluxOpenCheckpointReceipt = (value: unknown): FluxOpenCheckpointReceipt => parseFluxOpenCheckpointReceiptSnapshot(value);

const parseFluxOpenCheckpointReceiptSnapshot = (value: unknown, legacyChildren = false): FluxOpenCheckpointReceipt => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 20, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "runId", "openPreflightReceiptIdentity", "kicadToolchainIdentity", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "isolatedFingerprint", "board", "editorLock", "ipcProbeSemanticIdentity", "checkpointInspectionSessionReceiptIdentity", "freshNetClassSemanticAuthorityIdentity", "freshProjectOpenPreparedSourceAuthorityIdentity", "freshNetClassPreparationEvidenceIdentity", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_CHECKPOINT_SCHEMA_VERSION || typeof safe.runId !== "string" || !ID.test(safe.runId) || typeof safe.isolatedFingerprint !== "string" || !DIGEST.test(safe.isolatedFingerprint)) throw new Error("Open checkpoint receipt is invalid");
  const ipcSocketIdentity = validateCanonicalIdentity(safe.ipcSocketIdentity, "ipcSocketIdentity");
  const inspectionBridgeIdentity = validateCanonicalIdentity(safe.inspectionBridgeIdentity, "inspectionBridgeIdentity"); const executionBridgeIdentity = validateCanonicalIdentity(safe.executionBridgeIdentity, "executionBridgeIdentity");
  if (ipcSocketIdentity.schemaVersion !== KICAD_API_SOCKET_BINDING_SCHEMA_VERSION || inspectionBridgeIdentity.schemaVersion !== KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION || executionBridgeIdentity.schemaVersion !== KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION) throw new Error("Open checkpoint bridge or IPC socket identity is invalid");
  const writeSessionAuthorityIdentity = validateCanonicalIdentity(safe.writeSessionAuthorityIdentity, "writeSessionAuthorityIdentity");
  if (writeSessionAuthorityIdentity.schemaVersion !== KICAD_MCP_SESSION_AUTHORITY_SCHEMA_VERSION) throw new Error("Open checkpoint write-session authority identity is invalid");
  const ipcProbeSemanticIdentity = validateCanonicalIdentity(safe.ipcProbeSemanticIdentity, "ipcProbeSemanticIdentity"); const checkpointInspectionSessionReceiptIdentity = validateCanonicalIdentity(safe.checkpointInspectionSessionReceiptIdentity, "checkpointInspectionSessionReceiptIdentity");
  if (ipcProbeSemanticIdentity.schemaVersion !== FLUX_OPEN_IPC_PROBE_SEMANTIC_SCHEMA_VERSION || checkpointInspectionSessionReceiptIdentity.schemaVersion !== KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION) throw new Error("Open checkpoint semantic probe or inspection session receipt identity is invalid");
  const freshNetClassSemanticAuthorityIdentity = safe.freshNetClassSemanticAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshNetClassSemanticAuthorityIdentity, "freshNetClassSemanticAuthorityIdentity");
  const freshProjectOpenPreparedSourceAuthorityIdentity = safe.freshProjectOpenPreparedSourceAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshProjectOpenPreparedSourceAuthorityIdentity, "freshProjectOpenPreparedSourceAuthorityIdentity");
  const freshNetClassPreparationEvidenceIdentity = safe.freshNetClassPreparationEvidenceIdentity === null ? null : validateCanonicalIdentity(safe.freshNetClassPreparationEvidenceIdentity, "freshNetClassPreparationEvidenceIdentity");
  if (freshNetClassSemanticAuthorityIdentity !== null && freshNetClassSemanticAuthorityIdentity.schemaVersion !== (legacyChildren ? LEGACY_FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION : FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION)) throw new Error("Open checkpoint fresh net-class semantic authority is invalid");
  if (freshProjectOpenPreparedSourceAuthorityIdentity !== null && freshProjectOpenPreparedSourceAuthorityIdentity.schemaVersion !== FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION) throw new Error("Open checkpoint prepared-source authority is invalid");
  if (freshNetClassPreparationEvidenceIdentity !== null && freshNetClassPreparationEvidenceIdentity.schemaVersion !== (legacyChildren ? LEGACY_FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION : FRESH_NETCLASS_PREPARATION_EVIDENCE_SCHEMA_VERSION)) throw new Error("Open checkpoint preparation evidence identity is invalid");
  const payload = { schemaVersion: FLUX_OPEN_CHECKPOINT_SCHEMA_VERSION, runId: safe.runId, openPreflightReceiptIdentity: validateCanonicalIdentity(safe.openPreflightReceiptIdentity, "openPreflightReceiptIdentity"),
    kicadToolchainIdentity: validateCanonicalIdentity(safe.kicadToolchainIdentity, "kicadToolchainIdentity"), inspectionBridgeIdentity, executionBridgeIdentity,
    ipcSocketIdentity, writeSessionAuthorityIdentity, isolatedFingerprint: safe.isolatedFingerprint,
    board: contentIdentity(safe.board), editorLock: contentIdentity(safe.editorLock), ipcProbeSemanticIdentity, checkpointInspectionSessionReceiptIdentity,
    freshNetClassSemanticAuthorityIdentity, freshProjectOpenPreparedSourceAuthorityIdentity, freshNetClassPreparationEvidenceIdentity };
  const identity = validateCanonicalIdentity(safe.identity, "openCheckpointIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_CHECKPOINT_SCHEMA_VERSION))) throw new Error("Open checkpoint receipt identity is invalid");
  return Object.freeze({ ...payload, identity });
};

const parseFluxOpenCheckpointReceiptV4 = (value: unknown): FluxOpenCheckpointReceiptV4 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "runId", "openPreflightReceiptIdentity", "kicadToolchainIdentity", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "isolatedFingerprint", "board", "editorLock", "ipcProbeSemanticIdentity", "checkpointInspectionSessionReceiptIdentity", "freshNetClassSemanticAuthorityIdentity", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_CHECKPOINT_SEMANTIC_SCHEMA_VERSION || typeof safe.runId !== "string" || !ID.test(safe.runId) || typeof safe.isolatedFingerprint !== "string" || !DIGEST.test(safe.isolatedFingerprint)) throw new Error("Semantic Open checkpoint receipt is invalid");
  const ipcSocketIdentity = validateCanonicalIdentity(safe.ipcSocketIdentity, "ipcSocketIdentity");
  const inspectionBridgeIdentity = validateCanonicalIdentity(safe.inspectionBridgeIdentity, "inspectionBridgeIdentity");
  const executionBridgeIdentity = validateCanonicalIdentity(safe.executionBridgeIdentity, "executionBridgeIdentity");
  const writeSessionAuthorityIdentity = validateCanonicalIdentity(safe.writeSessionAuthorityIdentity, "writeSessionAuthorityIdentity");
  const ipcProbeSemanticIdentity = validateCanonicalIdentity(safe.ipcProbeSemanticIdentity, "ipcProbeSemanticIdentity");
  const checkpointInspectionSessionReceiptIdentity = validateCanonicalIdentity(safe.checkpointInspectionSessionReceiptIdentity, "checkpointInspectionSessionReceiptIdentity");
  const freshNetClassSemanticAuthorityIdentity = safe.freshNetClassSemanticAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshNetClassSemanticAuthorityIdentity, "freshNetClassSemanticAuthorityIdentity");
  if (ipcSocketIdentity.schemaVersion !== KICAD_API_SOCKET_BINDING_SCHEMA_VERSION || inspectionBridgeIdentity.schemaVersion !== KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION || executionBridgeIdentity.schemaVersion !== KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION ||
    writeSessionAuthorityIdentity.schemaVersion !== KICAD_MCP_SESSION_AUTHORITY_SCHEMA_VERSION || ipcProbeSemanticIdentity.schemaVersion !== FLUX_OPEN_IPC_PROBE_SEMANTIC_SCHEMA_VERSION || checkpointInspectionSessionReceiptIdentity.schemaVersion !== KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION ||
    (freshNetClassSemanticAuthorityIdentity !== null && ![LEGACY_FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION].includes(freshNetClassSemanticAuthorityIdentity.schemaVersion))) throw new Error("Semantic Open checkpoint authority is invalid");
  const payload = { schemaVersion: FLUX_OPEN_CHECKPOINT_SEMANTIC_SCHEMA_VERSION, runId: safe.runId, openPreflightReceiptIdentity: validateCanonicalIdentity(safe.openPreflightReceiptIdentity, "openPreflightReceiptIdentity"),
    kicadToolchainIdentity: validateCanonicalIdentity(safe.kicadToolchainIdentity, "kicadToolchainIdentity"), inspectionBridgeIdentity, executionBridgeIdentity,
    ipcSocketIdentity, writeSessionAuthorityIdentity, isolatedFingerprint: safe.isolatedFingerprint, board: contentIdentity(safe.board), editorLock: contentIdentity(safe.editorLock),
    ipcProbeSemanticIdentity, checkpointInspectionSessionReceiptIdentity, freshNetClassSemanticAuthorityIdentity };
  const identity = validateCanonicalIdentity(safe.identity, "semanticOpenCheckpointIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_CHECKPOINT_SEMANTIC_SCHEMA_VERSION))) throw new Error("Semantic Open checkpoint identity is invalid");
  return Object.freeze({ ...payload, identity });
};

const parseFluxOpenCheckpointReceiptV5 = (value: unknown): FluxOpenCheckpointReceiptV5 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 20, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "runId", "openPreflightReceiptIdentity", "kicadToolchainIdentity", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "isolatedFingerprint", "board", "editorLock", "ipcProbeSemanticIdentity", "checkpointInspectionSessionReceiptIdentity", "freshNetClassSemanticAuthorityIdentity", "freshProjectOpenPreparedSourceAuthorityIdentity", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_CHECKPOINT_PREPARED_SOURCE_SCHEMA_VERSION || typeof safe.runId !== "string" || !ID.test(safe.runId) || typeof safe.isolatedFingerprint !== "string" || !DIGEST.test(safe.isolatedFingerprint)) throw new Error("Prepared-source Open checkpoint receipt is invalid");
  const ipcSocketIdentity = validateCanonicalIdentity(safe.ipcSocketIdentity, "ipcSocketIdentity"); const inspectionBridgeIdentity = validateCanonicalIdentity(safe.inspectionBridgeIdentity, "inspectionBridgeIdentity"); const executionBridgeIdentity = validateCanonicalIdentity(safe.executionBridgeIdentity, "executionBridgeIdentity");
  const writeSessionAuthorityIdentity = validateCanonicalIdentity(safe.writeSessionAuthorityIdentity, "writeSessionAuthorityIdentity"); const ipcProbeSemanticIdentity = validateCanonicalIdentity(safe.ipcProbeSemanticIdentity, "ipcProbeSemanticIdentity"); const checkpointInspectionSessionReceiptIdentity = validateCanonicalIdentity(safe.checkpointInspectionSessionReceiptIdentity, "checkpointInspectionSessionReceiptIdentity");
  const freshNetClassSemanticAuthorityIdentity = safe.freshNetClassSemanticAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshNetClassSemanticAuthorityIdentity, "freshNetClassSemanticAuthorityIdentity");
  const freshProjectOpenPreparedSourceAuthorityIdentity = safe.freshProjectOpenPreparedSourceAuthorityIdentity === null ? null : validateCanonicalIdentity(safe.freshProjectOpenPreparedSourceAuthorityIdentity, "freshProjectOpenPreparedSourceAuthorityIdentity");
  if (ipcSocketIdentity.schemaVersion !== KICAD_API_SOCKET_BINDING_SCHEMA_VERSION || inspectionBridgeIdentity.schemaVersion !== KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION || executionBridgeIdentity.schemaVersion !== KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION ||
    writeSessionAuthorityIdentity.schemaVersion !== KICAD_MCP_SESSION_AUTHORITY_SCHEMA_VERSION || ipcProbeSemanticIdentity.schemaVersion !== FLUX_OPEN_IPC_PROBE_SEMANTIC_SCHEMA_VERSION || checkpointInspectionSessionReceiptIdentity.schemaVersion !== KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION ||
    (freshNetClassSemanticAuthorityIdentity !== null && ![LEGACY_FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION, FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION].includes(freshNetClassSemanticAuthorityIdentity.schemaVersion)) ||
    (freshProjectOpenPreparedSourceAuthorityIdentity !== null && freshProjectOpenPreparedSourceAuthorityIdentity.schemaVersion !== FRESH_PROJECT_OPEN_PREPARED_SOURCE_AUTHORITY_SCHEMA_VERSION)) throw new Error("Prepared-source Open checkpoint authority is invalid");
  const payload = { schemaVersion: FLUX_OPEN_CHECKPOINT_PREPARED_SOURCE_SCHEMA_VERSION, runId: safe.runId, openPreflightReceiptIdentity: validateCanonicalIdentity(safe.openPreflightReceiptIdentity, "openPreflightReceiptIdentity"),
    kicadToolchainIdentity: validateCanonicalIdentity(safe.kicadToolchainIdentity, "kicadToolchainIdentity"), inspectionBridgeIdentity, executionBridgeIdentity, ipcSocketIdentity, writeSessionAuthorityIdentity,
    isolatedFingerprint: safe.isolatedFingerprint, board: contentIdentity(safe.board), editorLock: contentIdentity(safe.editorLock), ipcProbeSemanticIdentity, checkpointInspectionSessionReceiptIdentity,
    freshNetClassSemanticAuthorityIdentity, freshProjectOpenPreparedSourceAuthorityIdentity };
  const identity = validateCanonicalIdentity(safe.identity, "preparedSourceOpenCheckpointIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_CHECKPOINT_PREPARED_SOURCE_SCHEMA_VERSION))) throw new Error("Prepared-source Open checkpoint identity is invalid");
  return Object.freeze({ ...payload, identity });
};

const parseFluxOpenCheckpointReceiptV1 = (value: unknown): FluxOpenCheckpointReceiptV1 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "runId", "openPreflightReceiptIdentity", "kicadToolchainIdentity", "isolatedFingerprint", "board", "editorLock", "ipcProbeIdentity", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_CHECKPOINT_LEGACY_SCHEMA_VERSION || typeof safe.runId !== "string" || !ID.test(safe.runId) || typeof safe.isolatedFingerprint !== "string" || !DIGEST.test(safe.isolatedFingerprint)) throw new Error("Legacy Open checkpoint receipt is invalid");
  const payload = { schemaVersion: FLUX_OPEN_CHECKPOINT_LEGACY_SCHEMA_VERSION, runId: safe.runId, openPreflightReceiptIdentity: validateCanonicalIdentity(safe.openPreflightReceiptIdentity, "openPreflightReceiptIdentity"),
    kicadToolchainIdentity: validateCanonicalIdentity(safe.kicadToolchainIdentity, "kicadToolchainIdentity"), isolatedFingerprint: safe.isolatedFingerprint,
    board: contentIdentity(safe.board), editorLock: contentIdentity(safe.editorLock), ipcProbeIdentity: validateCanonicalIdentity(safe.ipcProbeIdentity, "ipcProbeIdentity") };
  const identity = validateCanonicalIdentity(safe.identity, "legacyOpenCheckpointIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_CHECKPOINT_LEGACY_SCHEMA_VERSION))) throw new Error("Legacy Open checkpoint receipt identity is invalid");
  return Object.freeze({ ...payload, identity });
};

const parseFluxOpenCheckpointReceiptV2 = (value: unknown): FluxOpenCheckpointReceiptV2 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "runId", "openPreflightReceiptIdentity", "kicadToolchainIdentity", "inspectionBridgeIdentity", "isolatedFingerprint", "board", "editorLock", "ipcProbeIdentity", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_CHECKPOINT_BRIDGE_SCHEMA_VERSION || typeof safe.runId !== "string" || !ID.test(safe.runId) || typeof safe.isolatedFingerprint !== "string" || !DIGEST.test(safe.isolatedFingerprint)) throw new Error("Bridge-only Open checkpoint receipt is invalid");
  const payload = { schemaVersion: FLUX_OPEN_CHECKPOINT_BRIDGE_SCHEMA_VERSION, runId: safe.runId, openPreflightReceiptIdentity: validateCanonicalIdentity(safe.openPreflightReceiptIdentity, "openPreflightReceiptIdentity"),
    kicadToolchainIdentity: validateCanonicalIdentity(safe.kicadToolchainIdentity, "kicadToolchainIdentity"), inspectionBridgeIdentity: validateCanonicalIdentity(safe.inspectionBridgeIdentity, "inspectionBridgeIdentity"), isolatedFingerprint: safe.isolatedFingerprint,
    board: contentIdentity(safe.board), editorLock: contentIdentity(safe.editorLock), ipcProbeIdentity: validateCanonicalIdentity(safe.ipcProbeIdentity, "ipcProbeIdentity") };
  const identity = validateCanonicalIdentity(safe.identity, "bridgeOpenCheckpointIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_CHECKPOINT_BRIDGE_SCHEMA_VERSION))) throw new Error("Bridge-only Open checkpoint receipt identity is invalid");
  return Object.freeze({ ...payload, identity });
};

const parseFluxOpenCheckpointReceiptV3 = (value: unknown): FluxOpenCheckpointReceiptV3 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 16, maxKeyBytes: 64, maxStringBytes: 256 }));
  exact(safe, ["schemaVersion", "runId", "openPreflightReceiptIdentity", "kicadToolchainIdentity", "inspectionBridgeIdentity", "executionBridgeIdentity", "ipcSocketIdentity", "writeSessionAuthorityIdentity", "isolatedFingerprint", "board", "editorLock", "ipcProbeSemanticIdentity", "checkpointInspectionSessionReceiptIdentity", "identity"]);
  if (safe.schemaVersion !== FLUX_OPEN_CHECKPOINT_SOCKET_SCHEMA_VERSION || typeof safe.runId !== "string" || !ID.test(safe.runId) || typeof safe.isolatedFingerprint !== "string" || !DIGEST.test(safe.isolatedFingerprint)) throw new Error("Socket-bound Open checkpoint receipt is invalid");
  const ipcSocketIdentity = validateCanonicalIdentity(safe.ipcSocketIdentity, "ipcSocketIdentity"); const inspectionBridgeIdentity = validateCanonicalIdentity(safe.inspectionBridgeIdentity, "inspectionBridgeIdentity"); const executionBridgeIdentity = validateCanonicalIdentity(safe.executionBridgeIdentity, "executionBridgeIdentity");
  const writeSessionAuthorityIdentity = validateCanonicalIdentity(safe.writeSessionAuthorityIdentity, "writeSessionAuthorityIdentity"); const ipcProbeSemanticIdentity = validateCanonicalIdentity(safe.ipcProbeSemanticIdentity, "ipcProbeSemanticIdentity"); const checkpointInspectionSessionReceiptIdentity = validateCanonicalIdentity(safe.checkpointInspectionSessionReceiptIdentity, "checkpointInspectionSessionReceiptIdentity");
  if (ipcSocketIdentity.schemaVersion !== KICAD_API_SOCKET_BINDING_SCHEMA_VERSION || inspectionBridgeIdentity.schemaVersion !== KICAD_MCP_INSPECTION_BRIDGE_SCHEMA_VERSION || executionBridgeIdentity.schemaVersion !== KICAD_MCP_EXECUTION_BRIDGE_SCHEMA_VERSION || writeSessionAuthorityIdentity.schemaVersion !== KICAD_MCP_SESSION_AUTHORITY_SCHEMA_VERSION || ipcProbeSemanticIdentity.schemaVersion !== FLUX_OPEN_IPC_PROBE_SEMANTIC_SCHEMA_VERSION || checkpointInspectionSessionReceiptIdentity.schemaVersion !== KICAD_MCP_SESSION_RECEIPT_SCHEMA_VERSION) throw new Error("Socket-bound Open checkpoint authority is invalid");
  const payload = { schemaVersion: FLUX_OPEN_CHECKPOINT_SOCKET_SCHEMA_VERSION, runId: safe.runId, openPreflightReceiptIdentity: validateCanonicalIdentity(safe.openPreflightReceiptIdentity, "openPreflightReceiptIdentity"),
    kicadToolchainIdentity: validateCanonicalIdentity(safe.kicadToolchainIdentity, "kicadToolchainIdentity"), inspectionBridgeIdentity, executionBridgeIdentity, ipcSocketIdentity, writeSessionAuthorityIdentity,
    isolatedFingerprint: safe.isolatedFingerprint, board: contentIdentity(safe.board), editorLock: contentIdentity(safe.editorLock), ipcProbeSemanticIdentity, checkpointInspectionSessionReceiptIdentity };
  const identity = validateCanonicalIdentity(safe.identity, "socketOpenCheckpointIdentity");
  if (canonicalJson(identity) !== canonicalJson(canonicalIdentity(payload, FLUX_OPEN_CHECKPOINT_SOCKET_SCHEMA_VERSION))) throw new Error("Socket-bound Open checkpoint identity is invalid");
  return Object.freeze({ ...payload, identity });
};

export const parseFluxPersistedOpenCheckpointReceipt = (value: unknown): FluxOpenCheckpointReceipt | FluxOpenCheckpointReceiptV1 | FluxOpenCheckpointReceiptV2 | FluxOpenCheckpointReceiptV3 | FluxOpenCheckpointReceiptV4 | FluxOpenCheckpointReceiptV5 => {
  const safe = record(hardenPortableValue(value, { maxBytes: 16 * 1024, maxDepth: 5, maxNodes: 128, maxArrayLength: 8, maxOwnKeys: 20, maxKeyBytes: 64, maxStringBytes: 256 }));
  if (safe.schemaVersion === FLUX_OPEN_CHECKPOINT_LEGACY_SCHEMA_VERSION) return parseFluxOpenCheckpointReceiptV1(safe);
  if (safe.schemaVersion === FLUX_OPEN_CHECKPOINT_BRIDGE_SCHEMA_VERSION) return parseFluxOpenCheckpointReceiptV2(safe);
  if (safe.schemaVersion === FLUX_OPEN_CHECKPOINT_SOCKET_SCHEMA_VERSION) return parseFluxOpenCheckpointReceiptV3(safe);
  if (safe.schemaVersion === FLUX_OPEN_CHECKPOINT_SEMANTIC_SCHEMA_VERSION) return parseFluxOpenCheckpointReceiptV4(safe);
  return safe.schemaVersion === FLUX_OPEN_CHECKPOINT_PREPARED_SOURCE_SCHEMA_VERSION ? parseFluxOpenCheckpointReceiptV5(safe) : parseFluxOpenCheckpointReceiptSnapshot(safe, safe.freshNetClassSemanticAuthorityIdentity !== null && record(safe.freshNetClassSemanticAuthorityIdentity).schemaVersion === LEGACY_FRESH_NETCLASS_SEMANTIC_AUTHORITY_SCHEMA_VERSION);
};

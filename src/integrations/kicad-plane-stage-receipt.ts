import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";

export const COMPACT_PLANE_STAGE_SCHEMA = "evleda.native-plane-stage.v2";
const LEGACY = "evleda.native-plane-stage.v1";
const PAD = "type.googleapis.com/kiapi.board.types.Pad";
const MAX_BYTES = 8 * 1024 * 1024;
export const PLANE_STAGE_MAX_LOGICAL_NODES = 1_000_000;
type Obj = Record<string, unknown>;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Plane stage receipt: ${message}`);
}
function object(value: unknown): Obj {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "expected object");
  return value as Obj;
}

/** Resolve only the V2 protocol's explicit slots, sharing immutable pool values.
 * The wire retains the 8 MiB/500k-node limits. Logical traversal permits
 * 1M nodes and retains depth 64, so references cannot amplify downstream work without
 * a bound. Never serialize the expanded view to compute the receipt identity.
 */
export function decodePlaneStageReceipt(input: unknown) {
  const wire = object(hardenPortableValue(input, { maxBytes: MAX_BYTES, maxStringBytes: 1024 * 1024,
    maxDepth: 64, maxNodes: 500_000, maxArrayLength: 100_000, maxOwnKeys: 256, maxKeyBytes: 1024 }));
  const wireJson = canonicalJson(wire);
  check(Buffer.byteLength(wireJson, "utf8") <= MAX_BYTES, "canonical artifact exceeds 8 MiB");
  const receiptIdentity = contentIdentity(wireJson);
  if (wire.schemaVersion === LEGACY) return { receipt: wire, receiptIdentity, receiptIdentityEncoding: "canonical-json-observation" as const };
  check(wire.schemaVersion === COMPACT_PLANE_STAGE_SCHEMA, "unsupported schema");
  check(Array.isArray(wire.sourcePool) && wire.sourcePool.length <= 16, "invalid source pool");
  check(Array.isArray(wire.rpcPadPool) && wire.rpcPadPool.length <= 4096, "invalid PAD pool");
  const sources = wire.sourcePool.map(value => {
    check(typeof value === "string" && value.length > 0, "invalid source pool member"); return value;
  });
  const pads = wire.rpcPadPool.map(value => {
    const pad = object(value); check(pad["@type"] === PAD, "invalid PAD pool member"); return pad;
  });
  check(new Set(sources).size === sources.length && new Set(pads.map(canonicalJson)).size === pads.length, "duplicate pool member");
  const usedSources = new Set<number>(), usedPads = new Set<number>();
  function resolve<T>(value: unknown, key: string, pool: T[], used: Set<number>): T {
    const ref = object(value), index = ref[key];
    check(Object.keys(ref).length === 1 && typeof index === "number" && Number.isSafeInteger(index)
      && index >= 0 && index < pool.length, "invalid exact pool reference");
    used.add(index); return pool[index]!;
  }
  // Copy the bounded compact shell, then attach the already-hardened pool
  // members by reference. No PAD/source expansion into serialized JSON.
  const receipt = structuredClone(wire);
  delete receipt.sourcePool; delete receipt.rpcPadPool; receipt.schemaVersion = LEGACY;
  let sourceReferences = 0;
  function source(owner: Obj, key: string) {
    if (Object.hasOwn(owner, key)) {
      check(++sourceReferences <= 32, "too many source references");
      owner[key] = resolve(owner[key], "sourceIndex", sources, usedSources);
    }
  }
  for (const key of ["savedSourceBefore", "nativeSourceBefore", "nativeSourceUnfilled", "nativeSourceStaged", "savedSourceStaged", "currentSavedSource", "currentNativeSource"]) source(receipt, key);
  if (receipt.padSnapshot !== undefined) {
    const snapshot = object(receipt.padSnapshot); source(snapshot, "boardSourceBefore"); source(snapshot, "boardSourceAfter");
  }
  check(Array.isArray(receipt.rpc) && receipt.rpc.length <= 1024, "invalid RPC transcript");
  for (const value of receipt.rpc) {
    const call = object(value);
    if (call.requestType === "kiapi.common.commands.SaveDocumentToString" && call.response !== undefined) source(object(call.response), "contents");
    if (call.responseType !== "kiapi.common.commands.GetItemsResponse" || call.response === undefined) continue;
    const response = object(call.response);
    if (response.items === undefined) continue;
    check(Array.isArray(response.items) && response.items.length <= 4096, "invalid RPC items");
    response.items = response.items.map(value => {
      const item = object(value);
      if (Object.hasOwn(item, "padIndex")) return resolve(item, "padIndex", pads, usedPads);
      check(item["@type"] !== PAD, "inline PAD in compact transcript"); return item;
    });
  }
  check(usedSources.size === sources.length && usedPads.size === pads.length, "unreferenced pool member");
  let nodes = 0;
  function boundAndFreeze(value: unknown, depth: number): void {
    check(++nodes <= PLANE_STAGE_MAX_LOGICAL_NODES && depth <= 64, "logical traversal budget exceeded");
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) boundAndFreeze(child, depth + 1);
      Object.freeze(value);
    }
  }
  boundAndFreeze(receipt, 0);
  return { receipt, receiptIdentity, receiptIdentityEncoding: "canonical-json-compact-observation" as const };
}

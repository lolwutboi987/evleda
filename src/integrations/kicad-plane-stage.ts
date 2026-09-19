import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";

export const KICAD_PLANE_STAGE_TOOL = "evleda_stage_plane";
export const KICAD_PLANE_STAGE_TIMEOUT_MS = 90_000;
export const KICAD_PLANE_STAGE_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const KICAD_PLANE_STAGE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
export const PLANE_UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const uuid = z.string().regex(new RegExp(PLANE_UUID_PATTERN, "u"));
const label = z.string().min(1).max(128).regex(/^[^\x00-\x1f]+$/u);
const coordinate = z.number().int().min(-2_000_000_000).max(2_000_000_000);
const dimension = z.number().int().min(1).max(50_000_000);
const areaPattern = /^(?:0|[1-9][0-9]{0,18})$/u;
const area = z.string().regex(areaPattern).refine(value => areaPattern.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n, "Area exceeds signed native storage");

export type PlaneRectangleMutation = {
  netName: string; layer: "F.Cu" | "B.Cu";
  rectangleNm: { x1: number; y1: number; x2: number; y2: number };
  clearanceNm: number; minWidthNm: number; priority: number; name: string;
} & ({ operation: "create" } | { operation: "update"; zoneId: string })
  & ({ connection: "thermal"; thermalGapNm: number; thermalSpokeWidthNm: number; minimumSpokes: number }
    | { connection: "full"; thermalGapNm?: never; thermalSpokeWidthNm?: never; minimumSpokes?: never })
  & ({ islandPolicy: "area"; minIslandAreaNm2: string } | { islandPolicy: "always" | "never"; minIslandAreaNm2?: never });
const common = { netName: label, layer: z.enum(["F.Cu", "B.Cu"]),
  rectangleNm: z.object({ x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate }).strict()
    .refine(value => value.x1 < value.x2 && value.y1 < value.y2, "Rectangle must have positive area"),
  clearanceNm: dimension, minWidthNm: dimension, priority: z.number().int().min(0).max(100), name: label };
const operations = [{ operation: z.literal("create") }, { operation: z.literal("update"), zoneId: uuid }] as const;
const connections = [{ connection: z.literal("thermal"), thermalGapNm: dimension, thermalSpokeWidthNm: dimension, minimumSpokes: z.number().int().min(1).max(4) },
  { connection: z.literal("full") }] as const;
const islands = [{ islandPolicy: z.literal("area"), minIslandAreaNm2: area }, { islandPolicy: z.enum(["always", "never"]) }] as const;
const variants = operations.flatMap(operation => connections.flatMap(connection => islands.map(island => z.object({ ...common, ...operation, ...connection, ...island }).strict())));
export const planeRectangleMutationSchema: z.ZodType<PlaneRectangleMutation> = z.union([variants[0]!, ...variants.slice(1)]);
const sourceIdentity = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().min(1).max(1024 * 1024) }).strict();
export const planeStageRequestSchema = z.object({ expectedSavedIdentity: sourceIdentity, expectedLiveIdentity: sourceIdentity,
  mutation: planeRectangleMutationSchema.optional() }).strict();
/** Arguments are constructed by the owning host, never exposed as a public model tool. */
export const kicadPlaneStageInputSchema = z.object({ board_file: z.string().min(1).max(4096),
  zone_ids: z.array(uuid).max(32), reference_pads: z.array(z.object({ reference: label.max(64), pad: label.max(64), primitiveId: uuid }).strict()).min(1).max(128),
  request: planeStageRequestSchema }).strict().superRefine((value, context) => {
    if (new Set(value.zone_ids).size !== value.zone_ids.length || new Set(value.reference_pads.map(pad => pad.primitiveId)).size !== value.reference_pads.length) {
      context.addIssue({ code: "custom", message: "Plane stage inventories must be unique" });
    }
  });
export type KicadPlaneStageInput = z.infer<typeof kicadPlaneStageInputSchema>;
export const kicadPlaneStageArtifactSchema = z.object({ schemaVersion: z.literal("evleda.native-plane-stage-artifact.v1"),
  filename: z.string().regex(/^evleda-plane-stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u),
  identity: sourceIdentity.extend({ size: z.number().int().min(1).max(KICAD_PLANE_STAGE_MAX_ARTIFACT_BYTES) }).strict() }).strict();
export type KicadPlaneStageArtifact = z.infer<typeof kicadPlaneStageArtifactSchema>;
export const KICAD_PLANE_STAGE_INPUT_JSON_SCHEMA = z.toJSONSchema(kicadPlaneStageInputSchema);
export const KICAD_PLANE_STAGE_OUTPUT_JSON_SCHEMA = z.toJSONSchema(kicadPlaneStageArtifactSchema);

const receiptHeader = z.object({ schemaVersion: z.enum(["evleda.native-plane-stage.v1", "evleda.native-plane-stage.v2"]), complete: z.boolean(), nativeSaveCalled: z.literal(false),
  mutationDispatched: z.boolean(), recoveryRequired: z.boolean(), request: planeStageRequestSchema, rpc: z.array(z.unknown()).max(1024),
  assurance: z.object({ accepted: z.literal(false), minimumSpokes: z.literal("not_configured_by_zone_api"), highFrequencyValidity: z.literal("not_established") }).strict(),
}).passthrough();
export type KicadPlaneStageReceipt = z.infer<typeof receiptHeader>;

/** Read a complete host-bound receipt without expanding the ordinary MCP wire budget. */
export async function readKicadPlaneStageArtifact(outputRoot: string, reference: KicadPlaneStageArtifact, request: KicadPlaneStageInput["request"]): Promise<KicadPlaneStageReceipt> {
  const ref = kicadPlaneStageArtifactSchema.parse(reference);
  const root = path.resolve(outputRoot);
  if (!path.isAbsolute(outputRoot) || await realpath(root) !== root || (await lstat(root)).isSymbolicLink()) throw new Error("Plane receipt root is not the exact host-owned directory.");
  const target = path.join(root, ref.filename);
  const inspect = async () => {
    const info = await lstat(target, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size !== BigInt(ref.identity.size)
        || await realpath(target) !== target) throw new Error("Plane receipt file changed or is not an ordinary single-link artifact.");
    return info;
  };
  const before = await inspect(), handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const same = (value: typeof before) => value.ino === before.ino && value.dev === before.dev && value.size === before.size
      && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs && value.nlink === before.nlink;
    if (!same(await handle.stat({ bigint: true }))) throw new Error("Plane receipt changed while opening.");
    const bytes = Buffer.alloc(ref.identity.size + 1); let count = 0;
    while (count < bytes.length) { const part = await handle.read(bytes, count, bytes.length - count, count); if (part.bytesRead === 0) break; count += part.bytesRead; }
    const captured = bytes.subarray(0, count);
    if (count !== ref.identity.size || contentIdentity(captured).digest !== ref.identity.digest || !same(await handle.stat({ bigint: true })) || !same(await inspect())) throw new Error("Plane receipt bytes or physical identity changed.");
    const receipt = receiptHeader.parse(parsePortableJsonBytes(captured, { maxBytes: KICAD_PLANE_STAGE_MAX_ARTIFACT_BYTES, maxDepth: 64,
      maxNodes: 500_000, maxArrayLength: 100_000, maxOwnKeys: 256, maxKeyBytes: 1024, maxStringBytes: 1024 * 1024 }));
    if (canonicalJson(receipt.request) !== canonicalJson(request)) throw new Error("Plane receipt does not echo the exact host request.");
    if (receipt.complete && (receipt.recoveryRequired || !receipt.mutationDispatched)
        || !receipt.complete && receipt.mutationDispatched && !receipt.recoveryRequired) throw new Error("Plane receipt state contradicts completion/recovery.");
    // Full sources, native geometry, RPC/pad identity and mutation conformance
    // are intentionally validated by the higher-level host before any save.
    return receipt;
  } finally { await handle.close(); }
}

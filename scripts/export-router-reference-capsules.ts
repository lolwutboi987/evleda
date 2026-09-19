import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildRouterReferenceCapsule, type RouterReferenceCapsule } from "../src/harness/router-reference-capsule.js";

const [inputName, outputName, ...extra] = process.argv.slice(2);
if (!inputName || !outputName || extra.length || path.extname(outputName).toLowerCase() !== ".json") {
  throw new Error("Usage: node --import tsx scripts/export-router-reference-capsules.ts <capsules.json> <new-output.json>");
}
const bytes = await fs.readFile(inputName);
const input: unknown = JSON.parse(bytes.toString("utf8"));
if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a capsule input object.");
const request = input as Record<string, unknown>;
if (!Array.isArray(request.capsules) || request.capsules.length < 1 || request.capsules.length > 8192) {
  throw new Error("Expected between one and 8192 capsules.");
}
const grid = request.gridNm === undefined ? 100 : request.gridNm;
if (typeof grid !== "number") throw new Error("gridNm must be a number.");
const ids = new Set<string>();
const polygons = request.capsules.map((raw: unknown) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid capsule record.");
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length < 1 || row.id.length > 256 || ids.has(row.id)) {
    throw new Error("Capsule IDs must be unique nonempty strings of at most 256 characters.");
  }
  ids.add(row.id);
  for (const key of ["start", "end"] as const) {
    const point = row[key];
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("Invalid capsule endpoint.");
    const value = point as Record<string, unknown>;
    if (typeof value.xNm !== "number" || typeof value.yNm !== "number") throw new Error("Endpoint coordinates must be numeric nanometres.");
  }
  if (typeof row.radiusNm !== "number") throw new Error("radiusNm must be numeric nanometres.");
  const capsule = row as unknown as RouterReferenceCapsule;
  return { id: row.id, ...buildRouterReferenceCapsule(capsule, grid) };
});
await fs.writeFile(outputName, JSON.stringify({
  schemaVersion: "evleda.router-reference-polygons.v1",
  inputIdentity: { algorithm: "sha256", digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length },
  authority: "caller-supplied-geometry-only", nativeOperations: 0,
  notEvaluated: ["saved-board correspondence", "native clearance", "reference continuity", "impedance", "manufacturing"],
  polygons,
}, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({ output: path.resolve(outputName), polygons: polygons.length, nativeOperations: 0 }) + "\n");

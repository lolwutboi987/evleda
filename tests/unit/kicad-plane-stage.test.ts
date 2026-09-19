import { mkdtemp, mkdir, writeFile, rename, link, symlink, rm } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { planeRectangleMutationSchema, planeStageRequestSchema, kicadPlaneStageInputSchema,
  kicadPlaneStageArtifactSchema, readKicadPlaneStageArtifact, KICAD_PLANE_STAGE_MAX_ARTIFACT_BYTES,
  KICAD_PLANE_STAGE_INPUT_JSON_SCHEMA, KICAD_PLANE_STAGE_OUTPUT_JSON_SCHEMA } from "../../src/integrations/kicad-plane-stage.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualOpen = vi.mocked(filesystem.open).getMockImplementation()!;
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(filesystem.open).mockClear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const id = "12345678-1234-1234-1234-123456789abc";
const otherId = "12345678-1234-1234-1234-123456789abd";
const sourceIdentity = { algorithm: "sha256" as const, digest: "a".repeat(64), size: 100 };
const request = { expectedSavedIdentity: sourceIdentity, expectedLiveIdentity: { ...sourceIdentity, digest: "b".repeat(64) } };
const common = { netName: "GND", layer: "B.Cu", rectangleNm: { x1: -100, y1: 0, x2: 1000000, y2: 2000000 },
  clearanceNm: 250000, minWidthNm: 500000, priority: 0, name: "owned-zone" };
const variant = (operation: string, connection: string, island: string): Record<string, unknown> => ({ ...common,
  operation, ...(operation === "update" ? { zoneId: id } : {}), connection,
  ...(connection === "thermal" ? { thermalGapNm: 250000, thermalSpokeWidthNm: 500000, minimumSpokes: 2 } : {}),
  islandPolicy: island, ...(island === "area" ? { minIslandAreaNm2: "9223372036854775807" } : {}) });
const receipt = () => ({ schemaVersion: "evleda.native-plane-stage.v1", complete: true, nativeSaveCalled: false,
  mutationDispatched: true, recoveryRequired: false, request, rpc: [],
  assurance: { accepted: false, minimumSpokes: "not_configured_by_zone_api", highFrequencyValidity: "not_established" },
  rawPcbBefore: "  (kicad_pcb (version 20260206))\n", diagnostics: { unsupportedGeometry: ["fixture-unknown"] } });
async function artifact(bytes = Buffer.from(JSON.stringify(receipt()))) {
  const parent = await mkdtemp(path.join(tmpdir(), "kicad-plane-stage-")); roots.push(parent);
  const root = path.join(parent, "artifacts"); await mkdir(root);
  const filename = `evleda-plane-stage-${id}.json`, target = path.join(root, filename); await writeFile(target, bytes);
  return { parent, root, target, bytes, reference: { schemaVersion: "evleda.native-plane-stage-artifact.v1" as const, filename, identity: contentIdentity(bytes) } };
}

describe("closed native plane mutation arguments", () => {
  const variants = ["create", "update"].flatMap(operation => ["thermal", "full"].flatMap(connection => ["area", "always"].map(island => ({ operation, connection, island }))));
  it.each(variants)("accepts exact $operation/$connection/$island variant and rejects inactive fields", ({ operation, connection, island }) => {
    const value = variant(operation, connection, island);
    expect(planeRectangleMutationSchema.parse(value)).toEqual(value);
    const inactive = operation === "create" ? { zoneId: id } : connection === "full" ? { thermalGapNm: 1 } : island !== "area" ? { minIslandAreaNm2: "0" } : { arbitrary: true };
    expect(planeRectangleMutationSchema.safeParse({ ...value, ...inactive }).success).toBe(false);
    if (connection === "full") for (const field of ["thermalGapNm", "thermalSpokeWidthNm", "minimumSpokes"]) expect(planeRectangleMutationSchema.safeParse({ ...value, [field]: 1 }).success).toBe(false);
    if (island !== "area") expect(planeRectangleMutationSchema.safeParse({ ...value, islandPolicy: "never" }).success).toBe(true);
  });
  it.each(["-1", "+1", "01", "1.0", "1e3", " ", "", "not-an-integer", "9223372036854775808", "99999999999999999999"])("safeParse rejects invalid or overflowing native int64 area %s without throwing", area => {
    const value = { ...variant("create", "thermal", "area"), minIslandAreaNm2: area };
    expect(() => planeRectangleMutationSchema.safeParse(value)).not.toThrow();
    expect(planeRectangleMutationSchema.safeParse(value).success).toBe(false);
  });
  it("accepts canonical area zero and rejects numerical/fractional nm geometry", () => {
    expect(planeRectangleMutationSchema.safeParse({ ...variant("create", "thermal", "area"), minIslandAreaNm2: "0" }).success).toBe(true);
    for (const change of [{ minIslandAreaNm2: 42 }, { clearanceNm: 0.5 }, { minWidthNm: "500000" },
      { rectangleNm: { x1: 0, y1: 0, x2: 0, y2: 100 } }, { rectangleNm: { x1: 0, y1: 0, x2: 2000000001, y2: 100 } }]) {
      expect(planeRectangleMutationSchema.safeParse({ ...variant("create", "thermal", "area"), ...change }).success).toBe(false);
    }
  });
  it("requires unique exact zone and physical primitive bindings", () => {
    const value = { board_file: "host-owned-board", zone_ids: [id], reference_pads: [{ reference: "J1", pad: "3", primitiveId: otherId }], request };
    expect(kicadPlaneStageInputSchema.safeParse(value).success).toBe(true);
    expect(kicadPlaneStageInputSchema.safeParse({ ...value, zone_ids: [id, id] }).success).toBe(false);
    expect(kicadPlaneStageInputSchema.safeParse({ ...value, reference_pads: [value.reference_pads[0], value.reference_pads[0]] }).success).toBe(false);
    expect(kicadPlaneStageInputSchema.safeParse({ ...value, zone_ids: [id.toUpperCase()] }).success).toBe(false);
    expect(planeStageRequestSchema.safeParse({ ...request, arbitrary: true }).success).toBe(false);
    expect(KICAD_PLANE_STAGE_INPUT_JSON_SCHEMA).toHaveProperty("properties");
    expect(KICAD_PLANE_STAGE_OUTPUT_JSON_SCHEMA).toHaveProperty("properties");
  });
});

describe("complete native plane artifact reading", () => {
  it("preserves the compact header and pools for the semantic decoder", async () => {
    const value = { ...receipt(), schemaVersion: "evleda.native-plane-stage.v2", sourcePool: ["source"], rpcPadPool: [] };
    const f = await artifact(Buffer.from(JSON.stringify(value)));
    expect(await readKicadPlaneStageArtifact(f.root, f.reference, request)).toEqual(value);
  });
  it("uses a tiny filename/hash reference, preserves raw data, and makes no full-source acceptance inference", async () => {
    const f = await artifact();
    expect(Buffer.byteLength(JSON.stringify(f.reference))).toBeLessThan(1024);
    const read = await readKicadPlaneStageArtifact(f.root, f.reference, request);
    expect(read).toEqual(receipt());
    expect(read.rawPcbBefore).toBe(receipt().rawPcbBefore);
    expect(read.assurance.accepted).toBe(false);
    expect(read.assurance.minimumSpokes).toBe("not_configured_by_zone_api");
    expect(read).not.toHaveProperty("sourcePreservationValidated");
    // Header checks deliberately leave these source bytes and diagnostics for
    // higher-level validation; they are not a certificate of plane correctness.
  });
  it("reads a complete exact 8 MiB artifact without embedding it in the wire reference", async () => {
    const value = { ...receipt(), padding: Array.from({ length: 16 }, () => "") };
    let remaining = KICAD_PLANE_STAGE_MAX_ARTIFACT_BYTES - Buffer.byteLength(JSON.stringify(value));
    for (let i = 0; i < value.padding.length; i++) { const count = Math.min(remaining, 600000); value.padding[i] = "x".repeat(count); remaining -= count; }
    expect(remaining).toBe(0);
    const bytes = Buffer.from(JSON.stringify(value)); expect(bytes.length).toBe(8 * 1024 * 1024);
    const f = await artifact(bytes); const read = await readKicadPlaneStageArtifact(f.root, f.reference, request);
    expect(read.padding).toEqual(value.padding);
    expect(Buffer.byteLength(JSON.stringify(f.reference))).toBeLessThan(1024);
  });
  it.each(["../outside.json", "C:/outside.json", "subdir/evleda-plane-stage.json", `evleda-plane-stage-${id.toUpperCase()}.json`])("rejects path-like/noncanonical artifact filename %s", filename => {
    expect(kicadPlaneStageArtifactSchema.safeParse({ schemaVersion: "evleda.native-plane-stage-artifact.v1", filename, identity: sourceIdentity }).success).toBe(false);
  });
  it("rejects request echo drift", async () => {
    const f = await artifact();
    await expect(readKicadPlaneStageArtifact(f.root, f.reference, { ...request, expectedLiveIdentity: sourceIdentity })).rejects.toThrow("echo");
  });
  it.each([{ complete: true, mutationDispatched: false, recoveryRequired: false },
    { complete: true, mutationDispatched: true, recoveryRequired: true },
    { complete: false, mutationDispatched: true, recoveryRequired: false }])("rejects contradictory completion/recovery state %j", async state => {
    const f = await artifact(Buffer.from(JSON.stringify({ ...receipt(), ...state })));
    await expect(readKicadPlaneStageArtifact(f.root, f.reference, request)).rejects.toThrow("contradicts");
  });
  it("preserves incomplete recovery evidence rather than promoting it to complete", async () => {
    const value = { ...receipt(), complete: false, recoveryRequired: true };
    const f = await artifact(Buffer.from(JSON.stringify(value)));
    expect(await readKicadPlaneStageArtifact(f.root, f.reference, request)).toEqual(value);
  });
  it.each(["hash", "size", "oversize", "hardlink", "utf8", "root-alias"])("rejects %s artifact corruption", async kind => {
    const f = await artifact(kind === "utf8" ? Buffer.from([0xc3, 0x28]) : undefined);
    let root = f.root;
    const reference = kind === "oversize" ? { ...f.reference, identity: { ...f.reference.identity, size: KICAD_PLANE_STAGE_MAX_ARTIFACT_BYTES + 1 } } : f.reference;
    if (kind === "hash") await writeFile(f.target, "x".repeat(f.bytes.length));
    if (kind === "size") await writeFile(f.target, "short");
    if (kind === "hardlink") await link(f.target, path.join(f.parent, "shared.json"));
    if (kind === "root-alias") { root = path.join(f.parent, "alias"); await symlink(f.root, root, "junction"); }
    await expect(readKicadPlaneStageArtifact(root, reference, request)).rejects.toThrow();
  });
  it("rejects physical entry replacement between inspection and open even when bytes match", async () => {
    const f = await artifact();
    vi.mocked(filesystem.open).mockImplementationOnce(async (...args) => {
      const replacement = path.join(f.parent, "replacement.json"); await writeFile(replacement, f.bytes); await rename(replacement, f.target);
      return await actualOpen(...args);
    });
    await expect(readKicadPlaneStageArtifact(f.root, f.reference, request)).rejects.toThrow("changed while opening");
  });
});

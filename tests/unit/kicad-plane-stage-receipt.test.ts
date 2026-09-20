import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { decodePlaneStageReceipt } from "../../src/integrations/kicad-plane-stage-receipt.js";
import { compactPlaneStageFixture } from "../helpers/compact-plane-stage-fixture.js";

const PAD = "type.googleapis.com/kiapi.board.types.Pad";
function sample() {
  const board = '(kicad_pcb (property "text" "line\\nquote\\\"雪"))\r\n';
  const pad = { "@type": PAD, id: { value: "pad-id-for-codec-only" }, padstack: { layers: ["BL_F_Cu"] } };
  return { schemaVersion: "evleda.native-plane-stage.v1", savedSourceBefore: board, savedSourceStaged: board,
    nativeSourceBefore: board, nativeSourceStaged: board, nativeSourceUnfilled: board,
    padSnapshot: { boardSourceBefore: board, boardSourceAfter: board },
    rpc: [{ requestType: "kiapi.common.commands.SaveDocumentToString", response: { contents: board } },
      { responseType: "kiapi.common.commands.GetItemsResponse", response: { items: [pad, pad] } }] };
}
const compact = () => compactPlaneStageFixture(sample());

describe("bounded compact plane receipt", () => {
  it("losslessly decodes the modeled 507408-node real-board resource reproduction", () => {
    const study = JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/fresh-project/modeled-plane-stage-507408.json.gz", import.meta.url)),
      { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8"));
    expect(study.logicalNodes).toBe(507408);
    expect(study.scope).toContain("not a native stage or authority");
    const wire = compactPlaneStageFixture(study.transcript), before = canonicalJson(wire);
    const decoded = decodePlaneStageReceipt(wire);
    expect(decoded.receipt).toEqual(study.transcript);
    expect(canonicalJson(wire)).toBe(before);
    expect(decoded.receiptIdentity).toEqual(contentIdentity(before));
  });
  it("preserves exact text, ordered duplicate PADs and legacy identity without changing caller data", () => {
    const raw = sample(), encoded = compactPlaneStageFixture(raw), before = structuredClone(encoded);
    const decoded = decodePlaneStageReceipt(encoded);
    expect(decoded.receipt).toEqual(raw);
    expect(decoded.receiptIdentity).toEqual(contentIdentity(canonicalJson(encoded)));
    expect(decoded.receiptIdentityEncoding).toBe("canonical-json-compact-observation");
    expect(decodePlaneStageReceipt(raw).receiptIdentity).toEqual(contentIdentity(canonicalJson(raw)));
    expect(decodePlaneStageReceipt(raw).receiptIdentityEncoding).toBe("canonical-json-observation");
    expect(encoded).toEqual(before);
    const calls = decoded.receipt.rpc as any[];
    expect(calls[1].response.items[0]).toBe(calls[1].response.items[1]);
    expect(Object.isFrozen(calls[1].response.items[0].padstack.layers)).toBe(true);
    encoded.rpcPadPool[0]!.id.value = "changed";
    expect(calls[1].response.items[0].id.value).toBe("pad-id-for-codec-only");
  });
  it.each([
    ["fraction", { sourceIndex: 0.5 }], ["negative", { sourceIndex: -1 }],
    ["range", { sourceIndex: 1 }], ["bool", { sourceIndex: true }],
    ["string", { sourceIndex: "0" }], ["extra", { sourceIndex: 0, hidden: true }],
    ["inline", "board text"], ["wrong key", { padIndex: 0 }],
  ])("rejects %s source reference", (_name, ref) => {
    const value: any = compact(); value.savedSourceBefore = ref;
    expect(() => decodePlaneStageReceipt(value)).toThrow();
  });
  it.each([
    ["PAD range", (r: any) => { r.rpc[1].response.items[0] = { padIndex: 5 }; }],
    ["PAD extra", (r: any) => { r.rpc[1].response.items[0].extra = true; }],
    ["inline PAD", (r: any) => { r.rpc[1].response.items[0] = r.rpcPadPool[0]; }],
    ["wrong PAD type", (r: any) => { r.rpcPadPool[0]["@type"] = "Zone"; }],
    ["duplicate PAD pool", (r: any) => { r.rpcPadPool.push(structuredClone(r.rpcPadPool[0])); }],
    ["unused PAD", (r: any) => { r.rpcPadPool.push({ "@type": PAD, id: { value: "unused" } }); }],
    ["duplicate source", (r: any) => { r.sourcePool.push(r.sourcePool[0]); }],
    ["unused source", (r: any) => { r.sourcePool.push("unused"); }],
    ["source pool count", (r: any) => { r.sourcePool = Array.from({ length: 17 }, (_, i) => String(i)); }],
    ["source length", (r: any) => { r.sourcePool[0] = "x".repeat(1024 * 1024 + 1); }],
    ["source refs", (r: any) => { r.rpc.push(...Array.from({ length: 33 }, () => ({ requestType: "kiapi.common.commands.SaveDocumentToString", response: { contents: { sourceIndex: 0 } } }))); }],
    ["wire budget", (r: any) => { r.unused = Array.from({ length: 9 }, () => "x".repeat(1000000)); }],
  ])("rejects %s", (_name, change) => {
    const value = compact(); change(value); expect(() => decodePlaneStageReceipt(value)).toThrow();
  });
  it("retains the logical node budget despite tiny references", () => {
    const value = compact();
    value.rpcPadPool[0]!.large = Array.from({ length: 200 }, () => ({ x: 0 }));
    value.rpc[1].response.items = Array.from({ length: 3000 }, () => ({ padIndex: 0 }));
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(100_000);
    expect(() => decodePlaneStageReceipt(value)).toThrow("logical traversal budget");
  });
  it("retains complete repeated observations beyond the former 500k logical limit", () => {
    const value = compact();
    value.rpcPadPool[0]!.large = Array.from({ length: 200 }, (_, index) => ({ x: index }));
    value.rpc[1].response.items = Array.from({ length: 1300 }, () => ({ padIndex: 0 }));
    const decoded = decodePlaneStageReceipt(value), calls = decoded.receipt.rpc as any[];
    expect(calls[1].response.items).toHaveLength(1300);
    expect(calls[1].response.items[1299].large).toHaveLength(200);
    expect(calls[1].response.items[1299].large[199]).toEqual({ x: 199 });
    expect(calls[1].response.items[0]).toBe(calls[1].response.items[1299]);
    expect(Object.isFrozen(calls[1].response.items[1299].large)).toBe(true);
    expect(decoded.receiptIdentity).toEqual(contentIdentity(canonicalJson(value)));
  });
  it("retains logical depth after insertion at a deeper RPC location", () => {
    const value = compact(); let child: any = {};
    for (let i = 0; i < 59; i++) child = { nested: child };
    value.rpcPadPool[0]!.deep = child;
    expect(() => decodePlaneStageReceipt(value)).toThrow("logical traversal budget");
  });
  it("stores over 8 MiB of repeated source evidence within the unchanged wire cap", () => {
    const raw: any = sample(), board = "x".repeat(900_000);
    for (const key of ["savedSourceBefore", "nativeSourceBefore", "nativeSourceStaged", "nativeSourceUnfilled", "savedSourceStaged"]) raw[key] = board;
    raw.padSnapshot.boardSourceBefore = board; raw.padSnapshot.boardSourceAfter = board;
    raw.rpc[0].response.contents = board;
    raw.rpc.push(...Array.from({ length: 6 }, () => ({ requestType: "kiapi.common.commands.SaveDocumentToString", response: { contents: board } })));
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(8 * 1024 * 1024);
    const encoded = compactPlaneStageFixture(raw), decoded = decodePlaneStageReceipt(encoded);
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(1024 * 1024);
    expect(decoded.receipt).toEqual(raw);
    expect(() => decodePlaneStageReceipt(raw)).toThrow();
  });
  it("preserves incomplete recovery data and allows empty pools before any capture", () => {
    const raw = { schemaVersion: "evleda.native-plane-stage.v1", complete: false, mutationDispatched: false,
      recoveryRequired: false, rpc: [], error: { type: "failure", message: "original failure" } };
    expect(decodePlaneStageReceipt(compactPlaneStageFixture(raw)).receipt).toEqual(raw);
  });
  it("rejects accessors without invoking them", () => {
    let called = false; const value = compact();
    Object.defineProperty(value, "sourcePool", { get() { called = true; return []; }, enumerable: true });
    expect(() => decodePlaneStageReceipt(value)).toThrow(); expect(called).toBe(false);
  });
});

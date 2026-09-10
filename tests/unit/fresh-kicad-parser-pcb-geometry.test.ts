import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseFreshPcbSource, type FreshBounds, type FreshPoint } from "../../src/harness/fresh-kicad-parser.js";

interface NativePoint { readonly xMm: number; readonly yMm: number; readonly xNm: number; readonly yNm: number }
interface NativePad {
  readonly number: string;
  readonly netName: string;
  readonly position: NativePoint;
  readonly footprintRelativePosition: NativePoint;
  readonly absoluteAngleDeg: number;
  readonly footprintRelativeAngleDeg: number;
  readonly shapePosition: NativePoint;
  readonly shapeBoundingBox: Readonly<{ minXmm: number; minYmm: number; maxXmm: number; maxYmm: number }>;
}
interface NativeFootprint {
  readonly reference: string;
  readonly angleDeg: number;
  readonly pads: readonly NativePad[];
  readonly graphics: readonly { readonly layer: string; readonly start: NativePoint; readonly end: NativePoint }[];
}
interface NativeCase {
  readonly input: { readonly path: string; readonly sha256: string; readonly sizeBytes: number };
  readonly inputSource: string;
  readonly native: readonly NativeFootprint[];
  readonly saved: { readonly sha256: string; readonly sizeBytes: number };
  readonly savedSource: string;
  readonly nativeReload: readonly NativeFootprint[];
}
const oracle = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/native-pcb-coordinate-oracle.json", import.meta.url), "utf8")) as {
  readonly nativeExecutionByTests: boolean;
  readonly nativeVersion: string;
  readonly cases: readonly NativeCase[];
  readonly integrity: Readonly<Record<string, unknown>>;
};
const failed = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/attempt13-pcb-pad-geometry.json", import.meta.url), "utf8")) as {
  readonly sourceUtf8Base64: string;
  readonly pcbSha256: string;
  readonly nativePadItems: readonly { readonly description: string; readonly pos: FreshPoint; readonly uuid: string }[];
  readonly historicalWrongPadReadback: { readonly pads: readonly { readonly reference: string; readonly pad: string; readonly xMm: number; readonly yMm: number }[] };
  readonly nativeDrcCounts: { readonly violations: number; readonly unconnected: number };
};
const sha256 = (source: string | Buffer): string => createHash("sha256").update(source).digest("hex");
const nativePoint = ({ xMm, yMm }: NativePoint): FreshPoint => ({ x: xMm, y: yMm });
const nativeBounds = (item: NativeFootprint["graphics"][number]): FreshBounds => ({
  minX: Math.min(item.start.xMm, item.end.xMm), minY: Math.min(item.start.yMm, item.end.yMm),
  maxX: Math.max(item.start.xMm, item.end.xMm), maxY: Math.max(item.start.yMm, item.end.yMm),
});

describe("native PCB footprint coordinate convention", () => {
  it("retains a pinned headless oracle with native save/reload and unchanged source/runtime evidence", () => {
    expect(oracle.nativeExecutionByTests).toBe(false);
    expect(oracle.nativeVersion).toBe("10.0.3");
    expect(oracle.cases).toHaveLength(4);
    expect(oracle.integrity).toMatchObject({ runtimePinsUnchanged: true, runtimePycacheUnchanged: true,
      scratchPycacheEntries: 0, inputSourcesUnchanged: true, failedEvidenceUnchanged: true });
    for (const example of oracle.cases) {
      expect(sha256(example.inputSource)).toBe(example.input.sha256);
      expect(Buffer.byteLength(example.inputSource)).toBe(example.input.sizeBytes);
      expect(sha256(example.savedSource)).toBe(example.saved.sha256);
      expect(Buffer.byteLength(example.savedSource)).toBe(example.saved.sizeBytes);
      expect(example.nativeReload).toEqual(example.native);
    }
  });

  it.each(oracle.cases)("matches native asymmetric anchors and bounds in $input.path", (example) => {
    const expected = example.native[0]!;
    for (const source of [example.inputSource, example.savedSource]) {
      const footprint = parseFreshPcbSource(source).footprints[0]!;
      expect(footprint.reference).toBe(expected.reference);
      expect(((footprint.rotationDeg % 360) + 360) % 360).toBe(((expected.angleDeg % 360) + 360) % 360);
      for (const pad of expected.pads) {
        expect(footprint.pads.find((item) => item.number === pad.number)).toMatchObject({ at: nativePoint(pad.position), netName: pad.netName });
      }
      expect(footprint.courtyardBounds).toEqual(nativeBounds(expected.graphics.find((item) => item.layer === "F.Courtyard")!));
      expect(footprint.bodyBounds).toEqual(nativeBounds(expected.graphics.find((item) => item.layer === "F.Fab")!));
    }
  });

  it("preserves native absolute pad angles without using them a second time for electrical anchors", () => {
    for (const example of oracle.cases) {
      const expected = example.native[0]!;
      const parsed = parseFreshPcbSource(example.savedSource).footprints[0]!;
      for (const pad of expected.pads) {
        const match = new RegExp(`\\(pad "${pad.number}"[^\\n]*\\n\\s*\\(at ([^)]*)\\)`, "u").exec(example.savedSource);
        expect(match).not.toBeNull();
        const at = match![1]!.trim().split(/\s+/u).map(Number);
        expect(at).toEqual([pad.footprintRelativePosition.xMm, pad.footprintRelativePosition.yMm, pad.absoluteAngleDeg]);
        expect(pad.absoluteAngleDeg).toBe(({ "1": 37, "2": 90, "3": 123 } as const)[pad.number as "1" | "2" | "3"]);
        expect(parsed.pads.find((item) => item.number === pad.number)!.at).toEqual(nativePoint(pad.position));
      }
      const offsetPad = expected.pads.find((pad) => pad.number === "3")!;
      expect(offsetPad.shapePosition).not.toEqual(offsetPad.position);
      expect(parsed.pads.find((pad) => pad.number === "3")!.at).toEqual(nativePoint(offsetPad.position));
    }
  });

  it("normalizes negative/equivalent cardinal angles without losing native anchor precision", () => {
    const example = oracle.cases.find((entry) => entry.input.path.endsWith("rotation-270.kicad_pcb"))!;
    for (const angle of [-90, 630, -450]) {
      const source = example.inputSource.replace("(at 20 30 270)", `(at 20 30 ${angle})`);
      expect(source).not.toBe(example.inputSource);
      const parsed = parseFreshPcbSource(source).footprints[0]!;
      for (const pad of example.native[0]!.pads) expect(parsed.pads.find((item) => item.number === pad.number)!.at).toEqual(nativePoint(pad.position));
    }
  });

  it("uses the same native-source sign for the non-cardinal fallback", () => {
    const source = oracle.cases[0]!.inputSource.replace("(at 20 30 0)", "(at 20 30 45)");
    const pad = parseFreshPcbSource(source).footprints[0]!.pads[0]!;
    expect(pad.at.x).toBeCloseTo(20 + 2 / Math.sqrt(2), 12);
    expect(pad.at.y).toBeCloseTo(30 + 0.6 / Math.sqrt(2), 12);
  });

  it("corrects all four attempt13 rotated pad anchors against native DRC UUID evidence without altering the failed design", () => {
    const bytes = Buffer.from(failed.sourceUtf8Base64, "base64");
    expect(sha256(bytes)).toBe("bf03b9d97255c31ea5993ca6673394770dea0c5a327bd2df3834aa38787c2bff");
    expect(sha256(bytes)).toBe(failed.pcbSha256);
    const source = bytes.toString("utf8");
    const board = parseFreshPcbSource(source);
    expect(failed.nativeDrcCounts).toEqual({ violations: 9, unconnected: 4 });
    expect(failed.nativePadItems).toHaveLength(4);
    for (const item of failed.nativePadItems) {
      const match = /^Pad (\d+) \[([^\]]+)\] of (R[12]) on F\.Cu$/u.exec(item.description);
      expect(match).not.toBeNull();
      expect(source).toContain(`(uuid "${item.uuid}")`);
      const [padNumber, net, reference] = match!.slice(1);
      const pad = board.footprints.find((footprint) => footprint.reference === reference)!.pads.find((entry) => entry.number === padNumber)!;
      expect(pad).toMatchObject({ at: item.pos, netName: net });
      const old = failed.historicalWrongPadReadback.pads.find((entry) => entry.reference === reference && entry.pad === padNumber)!;
      expect(pad.at).not.toEqual({ x: old.xMm, y: old.yMm });
    }
    // Preserve the real misrouting and independent 90-degree VOUT bend as evidence.
    expect(board.segments).toHaveLength(7);
    expect(board.segments.find((segment) => segment.id === "6b50422c-ce29-4c2f-b164-bc3591c5f1c0"))
      .toMatchObject({ start: { x: 14, y: 11.175 }, end: { x: 14, y: 8.825 }, netName: "VOUT" });
    expect(board.outlineBounds).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 20 });
    expect(board.footprints.find((footprint) => footprint.reference === "J1")!.courtyardBounds)
      .toEqual({ minX: 3.23, minY: 8.23, maxX: 6.77, maxY: 16.85 });
  });
});

const netBoard = (net: string, table = "") => `(kicad_pcb (version 20260206) ${table}
  (footprint "Test:Pad" (layer "F.Cu") (at 0 0) (property "Reference" "U1") (property "Value" "X")
    (pad "1" smd rect (at 1 2) (size 1 0.5) (layers "F.Cu") ${net}))
  (segment (start 1 2) (end 3 2) (width 0.25) (layer "F.Cu") ${net})
  (via (at 3 2) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") ${net}))`;
const legacy = '(net 0 "") (net 1 "123") (net 2 "0")';

describe("quoted numeric PCB net names", () => {
  it.each([
    ['(net "123")', "", "123"], ['(net "0")', "", "0"],
    ['(net "123")', legacy, "123"], ['(net "0")', legacy, "0"],
    ["(net 1)", legacy, "123"], ["(net 2)", legacy, "0"],
    ['(net 1 "123")', legacy, "123"], ['(net 2 "0")', legacy, "0"],
    ["(net 0)", "", null], ["(net 0)", legacy, null],
    ['(net "")', "", null], ['(net "")', legacy, null],
  ] as const)("resolves %s with its quoted/name or unquoted/ID semantics", (net, table, expected) => {
    const board = parseFreshPcbSource(netBoard(net, table));
    expect(board.footprints[0]!.pads[0]!.netName).toBe(expected);
    expect(board.segments[0]!.netName).toBe(expected);
    expect(board.vias[0]!.netName).toBe(expected);
  });

  it.each([
    ["(net 123)", ""], ['(net "123")', '(net 123 "OTHER")'],
    ['(net "MISSING")', legacy], ['(net 1 "0")', legacy],
    ['(net 1 "123")', ""], ["(net VIN)", '(net 1 "VIN")'],
    ['(net "1" "123")', legacy], ['(net "0" "")', legacy],
    ['(net "123" "0")', '(net 0 "") (net 123 "0")'],
    ['(net "123")', `${legacy} (net 3 "123")`],
    ['(net "123")', `${legacy} (net 1 "OTHER")`],
  ])("retains undeclared/conflicting net rejection for %s", (net, table) => {
    expect(() => parseFreshPcbSource(netBoard(net!, table!))).toThrow();
  });
});

import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { normalizePcbResolvedFootprint } from "../../src/harness/pcb-design-compiler.js";
import { parseFreshPcbSource, parseFreshPcbSourceDocument } from "../../src/harness/fresh-kicad-parser.js";
import { parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { createFreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { seedFreshBoardFeatures, verifyFreshBoardFeatures } from "../../src/harness/fresh-board-features.js";
import { createNativeEmptyBoardSeed } from "../../src/harness/native-empty-board-seed.js";
import { boardFeatureFixture, holeId, holeSource, seededElectricalBoard } from "../helpers/board-feature-fixture.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("unsafe cleanup"); rmSync(root, { recursive: true, force: true }); } });
const fixture = (source = holeSource) => { const f = boardFeatureFixture(source); roots.push(f.root); return f; };
describe("bounded source-bound V2 board features", () => {
  it("retains electrical component and terminal inventories while source-binding every physical feature", () => {
    const f = fixture();
    f.resolver.captureSourceSelection({ symbolIds: [...new Set(f.draft.components.map(c => c.symbolLibId))], footprintIds: [...new Set(f.draft.components.map(c => c.footprintLibId))] });
    const bundle = f.bundle(), connectivity = createFreshConnectivityContract(bundle.contract);
    expect(bundle.contract.components).toHaveLength(3); expect(connectivity.components).toHaveLength(3);
    expect(bundle.libraryBinding.symbols).toHaveLength(3); expect(bundle.libraryBinding.footprints).toHaveLength(5);
    expect(bundle.libraryBinding.footprints.filter(fp => fp.reference.startsWith("H")).every(fp => fp.pads.length === 0)).toBe(true);
    expect(connectivity.nets.flatMap(net => net.endpoints)).toHaveLength(7);
    expect(bundle.libraryBinding.sourceSelection!.records.some(record => record.libraryId === holeId)).toBe(true);
    expect(bundle.boardFeatureLibrarySources).toHaveLength(1);
    expect(bundle.boardFeatureLibrarySources![0]!.sourceIdentity).toEqual(contentIdentity(holeSource));
    expect(parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), f.dependencies)).toEqual(bundle);
    expect(createFreshPlaneRules(bundle).source).toContain("(constraint hole_clearance (min 0.5mm))");
    expect(normalizePcbResolvedFootprint(f.resolver.resolveFootprint(holeId), holeId)).toBeNull();
  });
  it("materializes only from the bound source with exact exclusions, stable UUIDs and immutable poses", () => {
    const f = fixture(), bundle = f.bundle(), empty = createNativeEmptyBoardSeed(), seeded = seedFreshBoardFeatures(bundle, empty);
    const board = parseFreshPcbSource(seeded); expect(board.footprints).toHaveLength(2);
    expect(board.footprints.map(fp => [fp.reference, fp.libraryId, fp.at, fp.pads[0]!.physical.drill!.sizeMm])).toEqual([
      ["H1", holeId, { x: 3, y: 3 }, { x: 2.1, y: 2.1 }], ["H2", holeId, { x: 27, y: 17 }, { x: 2.1, y: 2.1 }],
    ]);
    expect(seeded).toContain("(attr board_only exclude_from_pos_files exclude_from_bom)");
    expect(seedFreshBoardFeatures(bundle, empty)).toBe(seeded);
    expect(seedFreshBoardFeatures(bundle, seeded)).toBe(seeded);
    expect(() => verifyFreshBoardFeatures(bundle, seeded, f.resolver)).not.toThrow();
    const ids = board.footprints.flatMap(fp => [fp.id, ...fp.pads.map(pad => pad.physical.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("never treats an arbitrary empty source as verified feature inventory", () => {
    const f = fixture(), bundle = f.bundle();
    expect(() => verifyFreshBoardFeatures(bundle, "(kicad_pcb)", f.resolver)).toThrow(/missing board feature/);
    expect(() => verifyFreshBoardFeatures(bundle, createNativeEmptyBoardSeed(), f.resolver)).toThrow(/missing board feature/);
  });
  it.each([
    ["numbered NPTH", (s: string) => s.replace('(pad ""', '(pad "1"')],
    ["assigned NPTH", (s: string) => s.replace('(drill 2.1)', '(drill 2.1) (net "GND")')],
    ["annular NPTH", (s: string) => s.replace('(size 2.1 2.1)', '(size 2.2 2.2)')],
    ["offset NPTH", (s: string) => s.replace('(drill 2.1)', '(drill 2.1 (offset 0.1 0))')],
    ["off-center NPTH", (s: string) => s.replace('(pad "" np_thru_hole circle (at 0 0)', '(pad "" np_thru_hole circle (at 0.1 0)')],
    ["wrong bore", (s: string) => s.replaceAll('2.1', '2.2')],
  ] as const)("rejects %s library sources", (_name, change) => {
    const f = fixture(change(holeSource)); expect(f.compile().disposition).not.toBe("ready");
  });
  it.each([
    ["numbered", (s: string) => s.replace('(pad ""', '(pad "1"')],
    ["assigned", (s: string) => s.replace('(drill 2.1)', '(drill 2.1) (net "GND")')],
    ["wrong bore", (s: string) => s.replace('(drill 2.1)', '(drill 2.2)')],
    ["drifted pose", (s: string) => s.replace('(at 3 3)', '(at 3.1 3)')],
    ["sub-nm pose", (s: string) => s.replace('(at 3 3)', '(at 3.000000000000000000001 3)')],
    ["copper graphic", (s: string) => s.replace('(layer "F.Fab")', '(layer "F.Cu")')],
    ["changed bore UUID", (s: string) => {
      const pad = parseFreshPcbSource(s).footprints.find(fp => fp.reference === "H1")!.pads[0]!;
      return s.replace(pad.physical.id!, "12121212-1212-4212-8212-121212121212");
    }],
    ["lost board-only", (s: string) => s.replace('attr board_only', 'attr')],
    ["lost BOM exclusion", (s: string) => s.replace(' exclude_from_bom', '')],
    ["lost position exclusion", (s: string) => s.replace(' exclude_from_pos_files', '')],
    ["unknown extra", (s: string) => s.replace(/\)\s*$/u, '(footprint "MountingHole:unknown" (layer "F.Cu") (at 3 4) (property "Reference" "H3")) )')],
  ] as const)("rejects %s board drift", (_name, change) => {
    const f = fixture(), bundle = f.bundle(), source = seededElectricalBoard(bundle);
    expect(() => verifyFreshBoardFeatures(bundle, source, f.resolver)).not.toThrow();
    expect(() => verifyFreshBoardFeatures(bundle, change(source), f.resolver)).toThrow();
  });
  it("rejects duplicate and dropped features and blocks checkpoint-style library drift", () => {
    const f = fixture(), bundle = f.bundle(), source = seededElectricalBoard(bundle);
    const root = parseFreshPcbSourceDocument(source), hole = root.children.find(node => node.name === "footprint" && node.values[0]?.value === holeId)!;
    const block = source.slice(hole.start, hole.end);
    expect(() => verifyFreshBoardFeatures(bundle, source.slice(0,hole.start)+source.slice(hole.end), f.resolver)).toThrow(/missing/);
    expect(() => verifyFreshBoardFeatures(bundle, source.replace(/\)\s*$/u, block + ')'), f.resolver)).toThrow(/duplicate/);
    writeFileSync(f.holePath, holeSource + "\n");
    expect(() => verifyFreshBoardFeatures(bundle, source, f.resolver)).toThrow(/changed/);
  });
  it.each(["duplicate", "colliding", "unknown", "edge", "electrical-reference"])("fails closed for %s contract features", kind => {
    const f = fixture(), draft = structuredClone(f.draft) as any;
    if (kind === "duplicate") draft.boardFeatures[1].reference = "H1";
    if (kind === "colliding") draft.boardFeatures[1].pose = draft.boardFeatures[0].pose;
    if (kind === "unknown") draft.boardFeatures[0].footprintLibId = "MountingHole:Missing";
    if (kind === "edge") draft.boardFeatures[0].pose.xMm = 0.5;
    if (kind === "electrical-reference") draft.boardFeatures[0].reference = "R1";
    expect(f.compile(draft).disposition).not.toBe("ready");
  });
  it("keeps omitted legacy shapes and source bytes free of new optional fields", () => {
    const f = fixture(); const { boardFeatures: _features, ...legacy } = f.draft;
    const parsed = parsePcbPlaneDesignIntentDraft(legacy), compiled = f.compile(legacy);
    expect(parsed).not.toHaveProperty("boardFeatures"); expect(compiled).not.toHaveProperty("boardFeatureLibrarySources");
    if (compiled.disposition !== "ready") throw new Error("legacy compilation failed");
    expect(createFreshConnectivityContract(compiled.contract)).not.toHaveProperty("boardFeatures");
    expect(compiled.libraryBinding.footprints).toHaveLength(3);
  });
});

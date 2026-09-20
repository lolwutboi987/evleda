import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createFourLayerConstructionBoardSeed } from "../../src/harness/interface-construction-seed.js";
import { pcbFourLayerConstructionSchema } from "../../src/harness/pcb-four-layer-construction.js";
import { parseFreshPcbSource, parseFreshPcbStackup } from "../../src/harness/fresh-kicad-parser.js";
import { createKicadStackupReader } from "../../src/integrations/kicad-stackup.js";
import { pcbPlaneDesignIntentDraftSchema } from "../../src/harness/pcb-design-plane-contract.js";
import { fourLayerConstruction } from "../helpers/four-layer-construction.js";
import { interfaceConstructionDraft } from "../helpers/interface-construction-bundle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("four-layer native construction foundation", () => {
  it("matches independent KiCad load/save capture and enables exactly the declared four copper layers", async () => {
    const source = createFourLayerConstructionBoardSeed(fourLayerConstruction());
    const captured = await readFile(new URL("../fixtures/fresh-project/native-four-layer-construction.kicad_pcb", import.meta.url), "utf8");
    const provenance = JSON.parse(await readFile(new URL("../fixtures/fresh-project/native-four-layer-construction.provenance.json", import.meta.url), "utf8"));
    expect(contentIdentity(captured)).toEqual(provenance.capture.identity);
    expect(source.replaceAll("\r\n", "\n")).toBe(captured);
    expect(parseFreshPcbStackup(source)).toMatchObject({ status: "explicit", observationsComplete: true, issues: [],
      boardCopperLayerOrder: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"], generalBoardThicknessMm: { value: 1.0304 } });
    expect(parseFreshPcbSource(source)).toMatchObject({ footprints: [], segments: [], vias: [], zoneNetNames: [], outlineBounds: null });
  });

  it("reads each adjacent dielectric independently and never substitutes nominal or total board thickness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-four-layer-")); roots.push(root);
    const pcbPath = path.join(root, "board.kicad_pcb");
    await writeFile(pcbPath, createFourLayerConstructionBoardSeed(fourLayerConstruction()));
    const read = await createKicadStackupReader({ pcbPath }), report = await read();
    expect(report.adjacentCopperSeparations.map(gap => [gap.fromCopper, gap.toCopper, gap.thicknessMm.value])).toEqual([
      ["F.Cu", "In1.Cu", .1], ["In1.Cu", "In2.Cu", .6], ["In2.Cu", "B.Cu", .2],
    ]);
    expect(report.stackup.layers.filter(layer => layer.kind === "dielectric").map(layer => [layer.type.value,
      layer.sublayers[0]!.material.value, layer.sublayers[0]!.epsilonR.value, layer.sublayers[0]!.thicknessLocked.value])).toEqual([
      ["prepreg", "synthetic front prepreg", 4.1, true], ["core", "synthetic core", 4.6, true], ["prepreg", "synthetic back prepreg", 3.9, true],
    ]);
    expect(report.impedanceValidation).toBe("not_performed");
  });

  it("keeps fabrication nominal and non-native material assertions out of native geometry", () => {
    const input = fourLayerConstruction(), original = createFourLayerConstructionBoardSeed(input);
    input.nominalFinishedBoardThicknessMm = 1.2;
    input.coreDielectric.frequencyHz = 123_000_000;
    input.conductor.roughnessNm = 1234;
    expect(createFourLayerConstructionBoardSeed(input)).toBe(original);
    expect(original).not.toContain("nominalFinishedBoardThicknessMm");
    expect(original).not.toContain("frequencyHz");
    expect(original).not.toContain("roughnessNm");
  });

  it("preserves asymmetric masks and an explicit absent mask without inventing constants", () => {
    const input = fourLayerConstruction(); input.solderMask.front = { kind: "absent" }; input.boardThicknessMm = 1.0204;
    const stack = parseFreshPcbStackup(createFourLayerConstructionBoardSeed(input));
    expect(stack.layers[0]!.sublayers[0]).toMatchObject({ thicknessMm: { value: 0 }, material: { status: "missing" }, epsilonR: { status: "missing" } });
    expect(stack.layers.at(-1)!.sublayers[0]).toMatchObject({ thicknessMm: { value: .02 }, material: { value: "synthetic back mask" } });
  });

  it.each([
    ["one-nanometre total mismatch", (v: any) => { v.boardThicknessMm += .000001; }],
    ["nominal substituted for native total", (v: any) => { v.boardThicknessMm = v.nominalFinishedBoardThicknessMm; }],
    ["fractional-nanometre inner copper", (v: any) => { v.inner1CopperThicknessMm = .0152001; }],
    ["missing middle dielectric", (v: any) => { delete v.coreDielectric; }],
    ["legacy single dielectric", (v: any) => { v.dielectric = v.coreDielectric; }],
    ["unknown layer-order override", (v: any) => { v.copperLayers = ["F.Cu", "In2.Cu", "In1.Cu", "B.Cu"]; }],
    ["nonfinite thickness", (v: any) => { v.backDielectric.thicknessMm = Infinity; }],
    ["negative zero", (v: any) => { v.inner2CopperThicknessMm = -0; }],
    ["unresolved material", (v: any) => { v.frontDielectric.material = null; }],
    ["native unspecified material", (v: any) => { v.frontDielectric.material = "Not specified"; }],
    ["unrepresentable scalar", (v: any) => { v.frontDielectric.relativePermittivity = 4.1234567891; }],
  ] as const)("rejects %s before producing a board", (_name, mutate) => {
    const input = fourLayerConstruction(); mutate(input);
    expect(pcbFourLayerConstructionSchema.safeParse(input).success).toBe(false);
    expect(() => createFourLayerConstructionBoardSeed(input)).toThrow();
  });

  it("does not advertise an unqualified four-layer public design path", () => {
    const draft = interfaceConstructionDraft(); draft.interfaceRequirements.construction = fourLayerConstruction();
    expect(pcbPlaneDesignIntentDraftSchema.safeParse(draft).success).toBe(false);
  });
});

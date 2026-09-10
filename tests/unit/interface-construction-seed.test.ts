import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createInterfaceConstructionBoardSeed } from "../../src/harness/interface-construction-seed.js";
import { parseFreshPcbSource, parseFreshPcbStackup } from "../../src/harness/fresh-kicad-parser.js";
import { createNativeEmptyBoardSeed } from "../../src/harness/native-empty-board-seed.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { constructionAssertion, constructionDependencies, interfaceConstructionBundle, interfaceConstructionDraft } from "../helpers/interface-construction-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

describe("authenticated new-board interface construction seed", () => {
  it("preserves the exact existing native-empty bytes when construction is omitted or none", () => {
    const none = interfaceConstructionDraft(); none.interfaceRequirements.construction = { mode: "none" };
    for (const draft of [planeDividerDraft(), none]) {
      const result = createInterfaceConstructionBoardSeed(interfaceConstructionBundle(draft));
      expect(result).toBe(createNativeEmptyBoardSeed());
      expect(contentIdentity(result)).toEqual(process.platform === "win32"
        ? { algorithm: "sha256", digest: "5f482a9458a6c5710ec5df740495991198d31009be38bce9c823abf0e83b4a85", size: 1814 }
        : { algorithm: "sha256", digest: "8be439fee8716117c4da47e1e947c749ff4889df564d25a51f2640dec48f4a09", size: 1733 });
    }
  });

  it("matches retained native load/save bytes and changes only general thickness and stackup", async () => {
    const bundle = interfaceConstructionBundle(), source = createInterfaceConstructionBoardSeed(bundle);
    // LF derivative of independent KiCad 10.0.3 SWIG CRLF LoadBoard/SaveBoard capture.
    const capturedLf = await readFile(new URL("../fixtures/fresh-project/native-two-layer-construction.kicad_pcb", import.meta.url), "utf8");
    expect(contentIdentity(capturedLf)).toEqual({ algorithm: "sha256", digest: "6f5200f82c9d50bb5d97a6a1fc1e700f9702142d1a5eb1a25680595177e12e0d", size: 2245 });
    expect(source).toBe(process.platform === "win32" ? capturedLf.replaceAll("\n", "\r\n") : capturedLf);
    const stackup = parseFreshPcbStackup(source);
    expect(stackup).toMatchObject({ status: "explicit", observationsComplete: true, issues: [], boardCopperLayerOrder: ["F.Cu", "B.Cu"],
      generalBoardThicknessMm: { status: "explicit", value: 1.57 } });
    expect(stackup.layers.map(layer => [layer.name, layer.sublayers[0]!.thicknessMm.value])).toEqual([
      ["F.Mask", 0], ["F.Cu", 0.035], ["dielectric 1", 1.5], ["B.Cu", 0.035], ["B.Mask", 0],
    ]);
    expect(stackup.layers[2]!.sublayers[0]).toMatchObject({ thicknessLocked: { value: true }, material: { value: "fixture laminate" },
      epsilonR: { value: 4 }, lossTangent: { value: 0.02 } });
    expect(parseFreshPcbSource(source)).toMatchObject({ footprints: [], segments: [], vias: [], zoneNetNames: [], outlineBounds: null });
    const lf = source.replaceAll("\r\n", "\n"), stackLf = stackup.stackupSource!.replaceAll("\r\n", "\n");
    expect(lf.replace(`\t\t${stackLf}\n`, "").replace("(thickness 1.57)", "(thickness 1.6)")).toBe(createNativeEmptyBoardSeed("linux"));
    for (const metadata of ["frequencyHz", "conductivity", "roughness", "permeability", "caller_assertion", "fixture specification"])
      expect(source).not.toContain(metadata);
  });

  it("preserves asymmetric mask materials, Unicode and escaped strings without adding source forms", () => {
    const draft = interfaceConstructionDraft(), construction = draft.interfaceRequirements.construction;
    construction.boardThicknessMm = 1.600001;
    construction.frontCopperThicknessMm = 0.035001;
    construction.dielectric.material = 'laminate "A" \\ batch (native) µ';
    construction.dielectric.relativePermittivity = 4.123456789;
    construction.dielectric.lossTangent = 0.0000000000000001;
    construction.surfaceFinish = 'finish "matte" \\ vendor';
    construction.solderMask.front = { kind: "present", thicknessMm: 0.01, material: "front mask", relativePermittivity: 3.3,
      lossTangent: 0.01, frequencyHz: 100_000_000, source: constructionAssertion() };
    construction.solderMask.back = { kind: "present", thicknessMm: 0.02, material: 'back "mask"', relativePermittivity: 3.2,
      lossTangent: 0.00001, frequencyHz: 100_000_000, source: constructionAssertion() };
    const source = createInterfaceConstructionBoardSeed(interfaceConstructionBundle(draft)), stack = parseFreshPcbStackup(source);
    expect(stack.status).toBe("explicit");
    expect(stack.layers).toHaveLength(5);
    expect(stack.layers[0]!.sublayers[0]).toMatchObject({ material: { value: "front mask" }, thicknessMm: { value: 0.01 }, epsilonR: { value: 3.3 }, lossTangent: { value: 0.01 } });
    expect(stack.layers[4]!.sublayers[0]).toMatchObject({ material: { value: 'back "mask"' }, thicknessMm: { value: 0.02 }, epsilonR: { value: 3.2 }, lossTangent: { value: 0.00001 } });
    expect(stack.layers[2]!.sublayers[0]).toMatchObject({ material: { value: construction.dielectric.material }, epsilonR: { value: 4.123456789 }, lossTangent: { value: 1e-16 } });
    expect(source).toContain("(loss_tangent 0.0000000000000001)");
    expect(source).toContain("(thickness 0.035001)");
  });

  it("requires authenticated bundles while accepting host-reconstructed portable bundles", () => {
    const bundle = interfaceConstructionBundle();
    for (const untrusted of [structuredClone(bundle), bundle.contract, null, { contract: { interfaceRequirements: { construction: { mode: "none" } } } }])
      expect(() => createInterfaceConstructionBoardSeed(untrusted as any)).toThrow(/authenticated V2/);
    const parsed = parsePcbPlaneCompilationBundle(serializePcbPlaneCompilationBundle(bundle), constructionDependencies);
    expect(createInterfaceConstructionBoardSeed(parsed)).toBe(createInterfaceConstructionBoardSeed(bundle));
  });

  it.each([
    [0.000001, 0.000003], [2147.483635, 2147.483637],
  ])("preserves exact native geometry at dielectric %s mm and total %s mm", (dielectric, total) => {
    const draft = interfaceConstructionDraft(), construction = draft.interfaceRequirements.construction;
    construction.frontCopperThicknessMm = construction.backCopperThicknessMm = 0.000001;
    construction.dielectric.thicknessMm = dielectric; construction.boardThicknessMm = total;
    const source = createInterfaceConstructionBoardSeed(interfaceConstructionBundle(draft)), stack = parseFreshPcbStackup(source);
    expect(stack.generalBoardThicknessMm.value).toBe(total);
    expect(stack.layers[2]!.sublayers[0]!.thicknessMm.value).toBe(dielectric);
    expect(source.match(/\(thickness 0\.000001\)/gu)).toHaveLength(2);
  });

  it.each([[0, "0"], [0.0001, "0.0001"], [0.0001000000001, "0.0001000000001"], [1e-16, "0.0000000000000001"]] as const)(
    "emits native scalar boundary %s without spelling or value drift", (value, spelling) => {
      const draft = interfaceConstructionDraft(); draft.interfaceRequirements.construction.dielectric.lossTangent = value;
      expect(createInterfaceConstructionBoardSeed(interfaceConstructionBundle(draft))).toContain(`(loss_tangent ${spelling})`);
    });

  it.each([
    ["fractional-nm", 0.0350001, 1.5700001, "frontCopperThicknessMm", "exact integer-nanometre"],
    ["overflow", 2147.483638, 2149.018638, "frontCopperThicknessMm", "2147.483637"],
  ] as const)("rejects %s geometry itself even when the declared total is balanced", (_name, copper, total, field, message) => {
    const draft = interfaceConstructionDraft();
    draft.interfaceRequirements.construction.frontCopperThicknessMm = copper;
    draft.interfaceRequirements.construction.boardThicknessMm = total;
    const result = compilePcbPlaneDesignIntentDraft(draft, constructionDependencies);
    expect(result.disposition).not.toBe("ready");
    expect(result.issues.some(issue => issue.path.endsWith(`/${field}`) && issue.message.includes(message))).toBe(true);
  });

  it.each([
    ["fractional nanometer", (c: any) => { c.frontCopperThicknessMm = 0.0350001; }],
    ["native overflow", (c: any) => { c.boardThicknessMm = 2147.483638; }],
    ["inconsistent total", (c: any) => { c.boardThicknessMm = 1.6; }],
    ["scalar precision loss", (c: any) => { c.dielectric.relativePermittivity = 4.1234567891; }],
    ["scalar underflow", (c: any) => { c.dielectric.lossTangent = 1e-20; }],
    ["native material sentinel", (c: any) => { c.dielectric.material = "Not specified"; }],
    ["native finish sentinel", (c: any) => { c.surfaceFinish = "not specified"; }],
    ["control-string injection", (c: any) => { c.dielectric.material = 'laminate\n)(net "injected")'; }],
  ] as const)("does not authenticate %s construction for preparation", (_name, mutate) => {
    const draft = interfaceConstructionDraft(); mutate(draft.interfaceRequirements.construction);
    expect(compilePcbPlaneDesignIntentDraft(draft, constructionDependencies).disposition).not.toBe("ready");
  });
});

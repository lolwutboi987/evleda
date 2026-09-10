import { link, mkdtemp, open, readFile, rm, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { parseFreshPcbStackup } from "../../src/harness/fresh-kicad-parser.js";
import { createKicadStackupReader, KICAD_STACKUP_SOURCE_MAX_BYTES } from "../../src/integrations/kicad-stackup.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const board = (stack: string, inner = "") => `(kicad_pcb (version 20260206)
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) ${inner} (2 "B.Cu" signal))
  (setup ${stack}))`;
const copper = (name: string) => `(layer "${name}" (type "copper") (thickness 0.035))`;
const dielectric = `(layer "dielectric 1" (type "prepreg") (thickness 1.51 locked)
  (material "FR-4 design construction") (epsilon_r 4.1) (loss_tangent 0.018))`;
const twoLayer = board(`(stackup
  (layer "F.SilkS" (type "Top Silk Screen")) (layer "F.Paste" (type "Top Solder Paste"))
  (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01) (epsilon_r 3.3) (color "Green"))
  ${copper("F.Cu")} ${dielectric} ${copper("B.Cu")}
  (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01))
  (layer "B.Paste" (type "Bottom Solder Paste")) (layer "B.SilkS" (type "Bottom Silk Screen"))
  (copper_finish "ENIG") (dielectric_constraints yes))`);

async function fixture(source: string | Buffer) {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-stackup-")); roots.push(root);
  const pcbPath = path.join(root, "board.kicad_pcb"); await writeFile(pcbPath, source);
  return { pcbPath, read: await createKicadStackupReader({ pcbPath }) };
}

describe("source-bound physical KiCad stackup observations", () => {
  it("retains physical order, mask/paste records and unknown fields without choosing mask as substrate", async () => {
    const f = await fixture(twoLayer); const result = await f.read();
    expect(result.sourceIdentity).toEqual(contentIdentity(Buffer.from(twoLayer)));
    expect(result.stackup.status).toBe("explicit");
    expect(result.stackup.layers.map(layer => layer.name)).toEqual(["F.SilkS", "F.Paste", "F.Mask", "F.Cu", "dielectric 1", "B.Cu", "B.Mask", "B.Paste", "B.SilkS"]);
    expect(result.stackup.generalBoardThicknessMm.value).toBe(1.6);
    expect(result.stackup.layers[2]!.sublayers[0]!.epsilonR.value).toBe(3.3);
    expect(result.stackup.layers[3]!.sublayers[0]!.material).toEqual({ status: "missing", value: null, sources: [] });
    expect(result.stackup.layers[4]!.sublayers[0]!.thicknessLocked.value).toBe(true);
    expect(result.adjacentCopperSeparations).toEqual([expect.objectContaining({
      fromCopper: "F.Cu", toCopper: "B.Cu", status: "explicit",
      dielectricSublayers: [{ layerIndex: 4, sublayerIndex: 0 }], thicknessMm: expect.objectContaining({ value: 1.51 }),
    })]);
    expect(result.impedanceValidation).toBe("not_performed");
    expect(result).not.toHaveProperty("passed");
    expect(Object.isFrozen(result.stackup.layers[4]!.sublayers[0]!.thicknessMm.sources)).toBe(true);
  });

  it("preserves bare addsublayer order, scientific notation and heterogeneous dielectrics without averaging", async () => {
    // Grammar: KiCad 10.0.3 parseBoardStackup; addsublayer is an atom between field groups.
    const source = board(`(stackup ${copper("F.Cu")}
      (layer "dielectric 1" (type "prepreg") (thickness 0.1 locked) (material "1080") (epsilon_r 4.1) (loss_tangent 0.02)
        addsublayer (thickness 2e-1) (material "2116") (epsilon_r 4.8) (loss_tangent 0.015))
      ${copper("In1.Cu")} (layer "dielectric 2" (type "core") (thickness 1.0) (material "Core") (epsilon_r 3.7))
      ${copper("B.Cu")})`, '(4 "In1.Cu" signal)');
    const f = await fixture(source); const result = await f.read();
    expect(result.stackup.status).toBe("explicit");
    const subs = result.stackup.layers[1]!.sublayers;
    expect(subs.map(sub => [sub.thicknessMm.value, sub.material.value, sub.epsilonR.value, sub.lossTangent.value])).toEqual([[0.1, "1080", 4.1, 0.02], [0.2, "2116", 4.8, 0.015]]);
    expect(subs[1]!.thicknessLocked.status).toBe("missing");
    expect(result.adjacentCopperSeparations[0]!.thicknessMm.value).toBeCloseTo(0.3);
    expect(result.adjacentCopperSeparations[1]!.thicknessMm.value).toBe(1);
    expect(result.adjacentCopperSeparations[0]).not.toHaveProperty("epsilonR");
    expect(result.stackup.layers[3]!.sublayers[0]!.lossTangent.status).toBe("missing");
  });

  it("does not replace absent stackup or dielectric values with overall thickness or default Er", async () => {
    const absent = parseFreshPcbStackup(board(""));
    expect(absent).toMatchObject({ status: "missing", layers: [], generalBoardThicknessMm: { status: "explicit", value: 1.6 } });
    const f = await fixture(board(`(stackup ${copper("F.Cu")} (layer "dielectric 1" (type "core")) ${copper("B.Cu")})`));
    const result = await f.read();
    expect(result.stackup.layers[1]!.sublayers[0]).toMatchObject({ thicknessMm: { status: "missing", value: null }, epsilonR: { status: "missing", value: null }, material: { status: "missing", value: null } });
    expect(result.adjacentCopperSeparations[0]).toMatchObject({ status: "missing", thicknessMm: { value: null } });
  });

  it("preserves unsupported fields and duplicates rather than silently accepting a truncated stackup", () => {
    const source = board(`(stackup ${copper("F.Cu")}
      (layer "dielectric 1" (type "core") (thickness 0.2) (thickness 0.3) (woven_glass (style "x")) addsublayer (epsilon_r 4.4))
      ${copper("B.Cu")} (future_setting (x "y")))`);
    const result = parseFreshPcbStackup(source);
    expect(result.status).toBe("unsupported");
    expect(result.observationsComplete).toBe(true);
    expect(result.layers[1]!.sublayers).toHaveLength(2);
    expect(result.layers[1]!.sublayers[0]!.thicknessMm).toEqual({ status: "unsupported", value: null, sources: ["(thickness 0.2)", "(thickness 0.3)"] });
    expect(result.layers[1]!.sublayers[0]!.unknownForms).toEqual(['(woven_glass (style "x"))']);
    expect(result.unknownForms).toEqual(['(future_setting (x "y"))']);
    expect(result.stackupSource).toContain("addsublayer");
  });

  it.each([
    { body: `(stackup ${copper("B.Cu")} ${dielectric} ${copper("F.Cu")})`, message: "copper order" },
    { body: `(stackup ${copper("F.Cu")} (layer "dielectric 1" (type "core") (thickness "0.5")) ${copper("B.Cu")})`, message: "thickness" },
    { body: `(stackup ${copper("F.Cu")} (layer "dielectric 1" (type "core") (epsilon_r NaN)) ${copper("B.Cu")})`, message: "epsilon_r" },
    { body: `(stackup (layer "F.Cu" (type "copper") addsublayer (thickness 0.035)) ${dielectric} ${copper("B.Cu")})`, message: "non-dielectric" },
  ])("keeps $message problems unsupported with the original observations", ({ body, message }) => {
    const result = parseFreshPcbStackup(board(body));
    expect(result.status).toBe("unsupported");
    expect(result.layers).toHaveLength(3);
    expect(result.issues.some(issue => issue.includes(message))).toBe(true);
  });

  it("does not treat an intervening mask or paste layer as dielectric separation", async () => {
    const f = await fixture(board(`(stackup ${copper("F.Cu")} (layer "F.Mask" (type "mask") (thickness 1.53) (epsilon_r 4)) ${copper("B.Cu")})`));
    const result = await f.read();
    expect(result.stackup.layers[1]!.kind).toBe("mask");
    expect(result.adjacentCopperSeparations[0]).toMatchObject({ status: "unsupported", dielectricSublayers: [], thicknessMm: { value: null } });
  });

  it("rejects ambiguous roots, future grammar and malformed syntax without selecting one stackup", () => {
    expect(parseFreshPcbStackup(board("(stackup)(stackup)"))).toMatchObject({ status: "unsupported", observationsComplete: false, layers: [] });
    expect(parseFreshPcbStackup(twoLayer.replace("20260206", "20990101")).status).toBe("unsupported");
    expect(parseFreshPcbStackup("(kicad_pcb")).toMatchObject({ status: "unsupported", observationsComplete: false, layers: [] });
  });

  it("reports unsupported complexity instead of silently dropping excess dielectric sublayers", () => {
    const source = board(`(stackup ${copper("F.Cu")} (layer "dielectric 1" (type "core") (thickness 0.1)
      ${"addsublayer (thickness 0.1) ".repeat(128)}) ${copper("B.Cu")})`);
    const result = parseFreshPcbStackup(source);
    expect(result).toMatchObject({ status: "unsupported", observationsComplete: false });
    expect(result.layers[1]!.sublayers).toEqual([]);
    expect(result.layers[1]!.source).toContain("addsublayer");
    expect(result.issues.some(issue => issue.includes("128 supported sublayers"))).toBe(true);
  });

  it("reads the checked-in six-layer native reference without collapsing distinct dielectrics", async () => {
    const source = await readFile(new URL("../../reference-designs/robotics-controller-v0/robotics-controller-v0.kicad_pcb", import.meta.url), "utf8");
    const result = parseFreshPcbStackup(source);
    expect(result.status, result.issues.join("\n")).toBe("explicit");
    expect(result.layers.filter(layer => layer.kind === "dielectric").map(layer => layer.sublayers[0]!.epsilonR.value)).toEqual([4.29, 3.96, 4.29, 3.96, 4.29]);
    expect(result.boardCopperLayerOrder).toEqual(["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "B.Cu"]);
  });

  it("rebinds observations to current bytes after an ordinary saved revision", async () => {
    const f = await fixture(twoLayer); const first = await f.read();
    const revised = twoLayer.replace("(thickness 1.51 locked)", "(thickness 1.52 locked)");
    await writeFile(f.pcbPath, revised);
    const second = await f.read();
    expect(first.sourceIdentity).not.toEqual(second.sourceIdentity);
    expect(second.sourceIdentity).toEqual(contentIdentity(Buffer.from(revised)));
    expect(second.adjacentCopperSeparations[0]!.thicknessMm.value).toBe(1.52);
  });

  it("rejects mutation during an observation instead of publishing stale bytes", async () => {
    const f = await fixture(twoLayer);
    const probe = await open(f.pcbPath, "r"); const prototype = Object.getPrototypeOf(probe); const originalRead = prototype.read;
    await probe.close();
    let changed = false;
    vi.spyOn(prototype, "read").mockImplementation(async function(this: FileHandle, ...args: unknown[]) {
      const result = await originalRead.apply(this, args);
      if (!changed) { changed = true; await writeFile(f.pcbPath, twoLayer.replace("1.51", "1.52")); }
      return result;
    });
    await expect(f.read()).rejects.toThrow("changed during observation");
  });

  it("rejects relative paths, hard links, invalid UTF-8 and oversized source", async () => {
    await expect(createKicadStackupReader({ pcbPath: "board.kicad_pcb" })).rejects.toThrow("absolute");
    const f = await fixture(twoLayer);
    await link(f.pcbPath, path.join(path.dirname(f.pcbPath), "alias.kicad_pcb"));
    await expect(f.read()).rejects.toThrow("ordinary");
    const invalid = await fixture(Buffer.from([0xff])); await expect(invalid.read()).rejects.toThrow();
    const large = await fixture(twoLayer); await truncate(large.pcbPath, KICAD_STACKUP_SOURCE_MAX_BYTES + 1);
    await expect(large.read()).rejects.toThrow("bounded read");
  });
});

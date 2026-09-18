import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKiCad10StockCatalog } from "../../src/harness/kicad-stock-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { planeDividerDraft } from "./plane-divider-draft.js";
import { seedFreshBoardFeatures } from "../../src/harness/fresh-board-features.js";
import { createNativeEmptyBoardSeed } from "../../src/harness/native-empty-board-seed.js";
export const holeId = "MountingHole:Hole_D2.1";
export const holeSource = `(footprint "Hole_D2.1" (version 20260206) (generator "fixture") (layer "F.Cu")
 (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
 (property "Value" "Hole_D2.1" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
 (attr exclude_from_pos_files exclude_from_bom)
 (fp_circle (center 0 0) (end 1.05 0) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab"))
 (pad "" np_thru_hole circle (at 0 0) (size 2.1 2.1) (drill 2.1) (layers "*.Cu" "*.Mask")))\n`;
export const boardFeature = (reference = "H1", xMm = 3, yMm = 3) => ({ kind: "npth_mounting_hole" as const,
  reference, footprintLibId: holeId, value: "Mounting hole D2.1", pose: { side: "front" as const, xMm, yMm, rotationDeg: 0 as const },
  boreDiameterMm: 2.1, minimumHoleToCopperMm: 0.5, minimumHoleToEdgeMm: 0.5 });
const symbol = (name: string, count: number, reference: string) => `(kicad_symbol_lib (version 20231120) (generator "fixture")
 (symbol "${name}" (property "Reference" "${reference}" (at 0 0 0)) (property "Value" "${name}" (at 0 0 0))
 (symbol "${name}_1_1" ${Array.from({ length: count }, (_, i) => `(pin passive line (at ${i * 2.54} 0 0) (length 2.54)
 (name "Pin ${i+1}" (effects (font (size 1.27 1.27)))) (number "${i+1}" (effects (font (size 1.27 1.27)))))`).join(" ")})))`;
const footprint = (name: string, count: number) => `(footprint "${name}" (version 20260206) (generator "fixture") (layer "F.Cu")
 (fp_rect (start -1 -1) (end ${count*2} 1) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
 (fp_rect (start -0.5 -0.5) (end ${count*2} 0.5) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab"))
 ${Array.from({ length: count }, (_, i) => `(pad "${i+1}" smd rect (at ${i*2} 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))`).join(" ")})`;
export function boardFeatureFixture(source = holeSource) {
  const root = mkdtempSync(path.join(tmpdir(), "evleda-board-features-"));
  const put = (relative: string, text: string) => { const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  put("symbols/Device.kicad_sym", symbol("R", 2, "R"));
  put("symbols/Connector_Generic.kicad_sym", symbol("Conn_01x03", 3, "J"));
  put("footprints/Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod", footprint("R_0603_1608Metric", 2));
  put("footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x03_P2.54mm_Vertical.kicad_mod", footprint("PinHeader_1x03_P2.54mm_Vertical", 3));
  const holePath = put("footprints/MountingHole.pretty/Hole_D2.1.kicad_mod", source);
  const resolver = createKiCad10StockCatalog({ symbolRoot: path.join(root, "symbols"), footprintRoot: path.join(root, "footprints"),
    stockSymbolNicknames: ["Connector_Generic", "Device"], stockFootprintNicknames: ["Connector_PinHeader_2.54mm", "MountingHole", "Resistor_SMD"] });
  const dependencies = { libraryResolver: resolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const draft = { ...planeDividerDraft(), boardFeatures: [boardFeature(), boardFeature("H2", 27, 17)] };
  const compile = (value: unknown = draft) => compilePcbPlaneDesignIntentDraft(value, dependencies);
  const bundle = () => { const compilation = compile(); if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
    return createPcbPlaneCompilationBundle({ originalPrompt: "Source-bound mechanical mounting fixture", compilation }, dependencies); };
  return { root, holePath, put, resolver, dependencies, draft, compile, bundle };
}
export function electricalBoard(bundle: ReturnType<ReturnType<typeof boardFeatureFixture>["bundle"]>, source = createNativeEmptyBoardSeed()) {
  const id = (index: number) => `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`;
  const blocks = bundle.contract.components.map((c, i) => `(footprint "${c.footprintLibId}" (uuid "${id(i+1)}") (layer "F.Cu") (at ${6+i*7} 10)
   (property "Reference" "${c.reference}") (property "Value" "${c.value}") ${c.pins.map((p, j) => `(pad "${p.pin}" smd rect (uuid "${id(100+i*10+j)}") (at ${j*2} 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (net "${p.assignment.kind === "net" ? p.assignment.net : ""}"))`).join(" ")})`).join("\n");
  const electrical = `(kicad_pcb ${blocks})`;
  return source.replace(/\)\s*$/u, `${electrical.slice("(kicad_pcb ".length, -1)}\n)\n`);
}
export const seededElectricalBoard = (bundle: ReturnType<ReturnType<typeof boardFeatureFixture>["bundle"]>) => electricalBoard(bundle, seedFreshBoardFeatures(bundle, createNativeEmptyBoardSeed()));

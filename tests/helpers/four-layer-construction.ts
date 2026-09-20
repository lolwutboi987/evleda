import type { PcbFourLayerConstruction } from "../../src/harness/pcb-four-layer-construction.js";
import { constructionAssertion, interfaceConstruction } from "./interface-construction-bundle.js";

/** Synthetic asymmetric stack; this is not a supplier stackup or material recommendation. */
export function fourLayerConstruction(): PcbFourLayerConstruction {
  const { mode: _mode, dielectric, ...common } = interfaceConstruction();
  const mask = (thicknessMm: number, material: string) => ({ kind: "present" as const, thicknessMm, material,
    relativePermittivity: 3.3, lossTangent: .02, frequencyHz: 100_000_000, source: constructionAssertion() });
  return { ...common, mode: "four_layer", nominalFinishedBoardThicknessMm: 1, boardThicknessMm: 1.0304,
    inner1CopperThicknessMm: .0152, inner2CopperThicknessMm: .0152,
    frontDielectric: { ...dielectric, thicknessMm: .1, material: "synthetic front prepreg", relativePermittivity: 4.1 },
    coreDielectric: { ...dielectric, thicknessMm: .6, material: "synthetic core", relativePermittivity: 4.6 },
    backDielectric: { ...dielectric, thicknessMm: .2, material: "synthetic back prepreg", relativePermittivity: 3.9 },
    solderMask: { front: mask(.01, "synthetic front mask"), back: mask(.02, "synthetic back mask") },
  };
}

import { z } from "zod";
import { pcbInterfaceConstructionSchema } from "./pcb-interface-requirements.js";

const two = pcbInterfaceConstructionSchema.shape;

/**
 * Physical declaration for the bounded F/In1/In2/B stack. Each gap retains its
 * own material assertions; no effective dielectric or impedance is inferred.
 * This schema does not add four-layer support to the public design compiler.
 */
export const pcbFourLayerConstructionSchema = pcbInterfaceConstructionSchema.omit({ mode: true, dielectric: true }).extend({
  mode: z.literal("four_layer"),
  nominalFinishedBoardThicknessMm: two.boardThicknessMm.describe("Supplier nominal finished thickness, independent of the explicitly modeled native layer sum."),
  inner1CopperThicknessMm: two.frontCopperThicknessMm,
  inner2CopperThicknessMm: two.frontCopperThicknessMm,
  frontDielectric: two.dielectric.describe("One homogeneous prepreg gap between F.Cu and In1.Cu."),
  coreDielectric: two.dielectric.describe("One homogeneous core gap between In1.Cu and In2.Cu."),
  backDielectric: two.dielectric.describe("One homogeneous prepreg gap between In2.Cu and B.Cu."),
}).strict().superRefine((value, context) => {
  const masks = [value.solderMask.front, value.solderMask.back].map(mask => mask.kind === "absent" ? 0 : mask.thicknessMm);
  const thicknesses = [value.frontCopperThicknessMm, value.inner1CopperThicknessMm,
    value.inner2CopperThicknessMm, value.backCopperThicknessMm,
    value.frontDielectric.thicknessMm, value.coreDielectric.thicknessMm, value.backDielectric.thicknessMm, ...masks];
  // Every schema thickness is an exact integer-nm value. Compare the sum in
  // that domain, never by a floating tolerance or a supplier nominal value.
  if (thicknesses.reduce((sum, thickness) => sum + Math.round(thickness * 1e6), 0) !== Math.round(value.boardThicknessMm * 1e6)) {
    context.addIssue({ code: "custom", path: ["boardThicknessMm"],
      message: "Native board thickness must equal all four copper layers, three dielectrics and declared masks in integer nanometres; supplier nominal thickness is not substituted." });
  }
});

export type PcbFourLayerConstruction = z.infer<typeof pcbFourLayerConstructionSchema>;

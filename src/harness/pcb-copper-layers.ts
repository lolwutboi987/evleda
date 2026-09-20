import { z } from "zod";

export const PCB_FOUR_COPPER_LAYER_ORDER = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"] as const;
export type PcbCopperLayer = typeof PCB_FOUR_COPPER_LAYER_ORDER[number];
export const pcbCopperLayerSchema = z.enum(PCB_FOUR_COPPER_LAYER_ORDER);
export const pcbLayerCountSchema = z.union([z.literal(2), z.literal(4)]);
export const pcbRouteLayerPreferenceSchema = z.enum([...PCB_FOUR_COPPER_LAYER_ORDER, "either", "any"]);
export const pcbCopperLayerOrder = (count: 2 | 4): readonly PcbCopperLayer[] => count === 2 ? ["F.Cu", "B.Cu"] : PCB_FOUR_COPPER_LAYER_ORDER;
export const comparePcbCopperLayers = (a: PcbCopperLayer, b: PcbCopperLayer): number =>
  PCB_FOUR_COPPER_LAYER_ORDER.indexOf(a) - PCB_FOUR_COPPER_LAYER_ORDER.indexOf(b);

/** Preference only; callers must also enforce the board and net-class layer sets. */
export function pcbRouteLayerMatchesPreference(layer: string, preferred: z.infer<typeof pcbRouteLayerPreferenceSchema>): boolean {
  return PCB_FOUR_COPPER_LAYER_ORDER.includes(layer as PcbCopperLayer)
    && (preferred === "any" || preferred === "either" && (layer === "F.Cu" || layer === "B.Cu") || layer === preferred);
}

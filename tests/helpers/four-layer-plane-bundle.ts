import { interfaceConstructionBundle, interfaceConstructionDraft } from "./interface-construction-bundle.js";
import { fourLayerConstruction } from "./four-layer-construction.js";

export function fourLayerPlaneDraft(): Record<string, any> {
  const draft = interfaceConstructionDraft();
  draft.scope.board.layerCount = 4;
  draft.scope.board.copperLayers = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"];
  draft.interfaceRequirements.construction = fourLayerConstruction();
  draft.netClasses.find((c: any) => c.id === "POWER").allowedLayers = [...draft.scope.board.copperLayers];
  draft.planes[0].layer = "In1.Cu";
  draft.planes.push({ ...structuredClone(draft.planes[0]), id: "BACK_GND", layer: "In2.Cu" });
  const ground = draft.routingConstraints.nets.find((r: any) => r.net === "GND");
  ground.additionalPlaneIds = ["BACK_GND"];
  ground.accessRouting.preferredLayer = "any";
  return draft;
}
export const fourLayerPlaneBundle = () => interfaceConstructionBundle(fourLayerPlaneDraft());

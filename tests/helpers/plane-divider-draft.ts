import { genericDividerDraft } from "./generic-divider-bundle.js";
import { PCB_PLANE_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-plane-contract.js";

/** Synthetic compiler fixture only; these values are not a native plane qualification. */
export function planeDividerDraft() {
  const base = genericDividerDraft();
  const reference = (signalEndpoint: { reference: string; pin: string }, referenceEndpoint: { reference: string; pin: string }) => ({ signalEndpoint, referenceEndpoint });
  return { ...base, schemaVersion: PCB_PLANE_DRAFT_SCHEMA_VERSION,
    netClasses: base.netClasses.map(entry => entry.id === "POWER" ? { ...entry, allowedLayers: ["F.Cu", "B.Cu"] } : entry),
    planes: [{ id: "GND_PLANE", net: "GND", layer: "B.Cu", boundary: { kind: "rectangle", minXmm: 0.5, minYmm: 0.5, maxXmm: 29.5, maxYmm: 19.5 },
      clearanceMm: 0.25, minimumCopperWidthMm: 0.5, copperFill: "solid",
      padConnection: { mode: "thermal", gapMm: 0.25, spokeWidthMm: 0.5, minimumConnectedSpokes: 2 },
      islandPolicy: { removeUnconnected: true, minimumAreaMm2: 0, requireSingleConnectedComponent: true } }],
    routingConstraints: { ...base.routingConstraints,
      viaPolicy: { mode: "bounded", maxTotal: 2, diameterMm: 0.6, drillMm: 0.3, minimumAnnularRingMm: 0.15 },
      nets: base.routingConstraints.nets.map(route => route.net === "GND"
        ? { net: "GND", topology: "plane", planeId: "GND_PLANE", accessRouting: { preferredLayer: "F.Cu", maxVias: 2, routeLength: { mode: "bounded", maximumMm: 10 } } }
        : { ...route, referencePath: route.net === "VIN" ? { mode: "continuous_plane", planeId: "GND_PLANE", signalLayer: "F.Cu",
          coverageMarginMm: 0.5, layerTransitions: "forbidden", terminalReferences: [
            reference({ reference: "J1", pin: "1" }, { reference: "J1", pin: "3" }),
            reference({ reference: "R1", pin: "1" }, { reference: "R2", pin: "2" }),
          ] } : { mode: "none" } }),
    },
  };
}

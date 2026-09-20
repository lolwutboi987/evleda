import { contentIdentity } from "../core/canonical.js";
import { pcbNativeNumericRuleLines } from "./pcb-native-numeric-rules.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";

/** Canonical generated rules only, not arbitrary user-authored rule evaluation. */
export function createFreshPlaneRules(bundle: PcbPlaneCompilationBundle) {
  // Authenticate the original in-process bundle, not merely its structural shape.
  if (!isAuthenticatedPcbPlaneCompilationBundle(bundle)) throw new Error("Plane rules require an authenticated V2 bundle.");
  const zones = bundle.contract.planes.map((plane, index) => Object.freeze({ planeId: plane.id,
    zoneName: `EVLEDA_PLANE_${bundle.identity.digest.slice(0, 12)}_P${String(index + 1).padStart(2, "0")}`,
    layer: plane.layer,
    thermal: plane.padConnection.mode === "solid" ? null : Object.freeze({
      minimumConnectedSpokes: plane.padConnection.minimumConnectedSpokes,
      gapMm: plane.padConnection.gapMm, spokeWidthMm: plane.padConnection.spokeWidthMm,
    }) }));
  const lines = ["(version 1)"];
  lines.push(...pcbNativeNumericRuleLines(bundle.contract));
  for (const feature of bundle.contract.boardFeatures ?? []) {
    // Schema-bound H references contain no expression metacharacters. The
    // companion physical constraint also checks intentionally netless copper.
    lines.push("", `(rule "EVLEDA_${feature.reference}_NPTH_COPPER"`,
      `  (condition "A.Type == 'Pad' && A.Reference == '${feature.reference}'")`, "  (severity error)",
      `  (constraint hole_clearance (min ${feature.minimumHoleToCopperMm}mm)))`);
    lines.push("", `(rule "EVLEDA_${feature.reference}_NPTH_PHYSICAL_COPPER"`, "  (layer outer)",
      `  (condition "A.Type == 'Pad' && A.Reference == '${feature.reference}'")`, "  (severity error)",
      `  (constraint physical_hole_clearance (min ${feature.minimumHoleToCopperMm}mm)))`);
    if (bundle.contract.scope.board.layerCount === 4) for (const layer of ["In1.Cu", "In2.Cu"] as const) {
      lines.push("", `(rule "EVLEDA_${feature.reference}_NPTH_PHYSICAL_${layer.replace(".", "_")}"`, `  (layer "${layer}")`,
        `  (condition "A.Type == 'Pad' && A.Reference == '${feature.reference}'")`, "  (severity error)",
        `  (constraint physical_hole_clearance (min ${feature.minimumHoleToCopperMm}mm)))`);
    }
  }
  for (const zone of zones) {
    if (zone.thermal === null) continue;
    const { minimumConnectedSpokes, gapMm, spokeWidthMm } = zone.thermal;
    // Names contain only fixed ASCII, digest hex and a numeric index; no raw
    // user identifier can become DRC expression syntax.
    lines.push("", `(rule "${zone.zoneName}_THERMAL"`, `  (layer "${zone.layer}")`,
      `  (condition "A.Type == 'Zone' && A.Name == '${zone.zoneName}'")`, "  (severity error)",
      `  (constraint min_resolved_spokes ${minimumConnectedSpokes})`,
      `  (constraint thermal_relief_gap (min ${gapMm}mm))`,
      `  (constraint thermal_spoke_width (min ${spokeWidthMm}mm) (opt ${spokeWidthMm}mm) (max ${spokeWidthMm}mm)))`);
  }
  const source = `${lines.join("\n")}\n`;
  return Object.freeze({ source, identity: Object.freeze(contentIdentity(source)), zones: Object.freeze(zones),
    limitations: Object.freeze([
      "This file configures the required policy; it does not prove the zone exists or that native DRC applied it.",
      "Bind each unique generated zone name to its actual native UUID, net, layer and source; reject duplicate matching zones.",
      "Minimum-resolved-spoke DRC applies to thermal pads, skips completely unconnected pads, and has separate custom-pad behavior; require independent terminal connectivity.",
      "Local pad thermal overrides can precede custom rules; inspect their absence or exact compatibility, plus exclusions and effective rule precedence.",
      "Spoke width can be clamped to pad dimensions by the native filler; configured dimensions alone are not observed copper acceptance.",
    ]) });
}

import type { PcbPlaneDesignContract } from "./pcb-design-plane-contract.js";
import { channelForNet } from "./pcb-channel-width.js";
import { routeSourceMmToNativeNm } from "./fresh-route-native-units.js";

export const PCB_NATIVE_NUMERIC_RULE_MODE = "contract-derived-v1" as const;
export const PCB_NATIVE_NUMERIC_RULE_GUIDANCE = "nativeRuleMode=contract-derived-v1 binds native global floors and exact per-net track/edge constraints to the existing V2 class and channel width intent. Routed vias receive their declared diameter, drill and annular minima. Unmatched copper and footprint pad drills retain the previous native defaults. This numeric projection does not establish manufacturing suitability, ampacity, impedance, channel escape locality, or completed routing; existing exact route, escape, layer, clearance, corner, source and native DRC checks remain required.";
export const PCB_NATIVE_HOLE_SPACING_GUIDANCE = "Explicit routingConstraints.minimumHoleToHoleMm binds the native global edge-to-edge hole spacing for both plated and non-plated holes; it is caller-supplied design intent, not verified fabrication capability.";
const defaults = Object.freeze({ min_track_width: 0.2, min_copper_edge_clearance: 0.5, min_through_hole_diameter: 0.3,
  min_via_annular_width: 0.1, min_via_diameter: 0.5, min_clearance: 0, min_hole_clearance: 0.25, min_hole_to_hole: 0.25 });
export type PcbNativeBoardRules = typeof defaults extends infer T ? { readonly [K in keyof T]: number } : never;
const requiredNativeCheckSeverities = Object.freeze({ track_width: "error", track_angle: "error" } as const);
const exact = (value: number): number => routeSourceMmToNativeNm(value) / 1_000_000;

/** One deterministic projection; omission preserves every legacy writer/reader. */
export function derivePcbNativeNumericRules(contract: PcbPlaneDesignContract) {
  if (contract.nativeRuleMode === undefined) return undefined;
  if (contract.nativeRuleMode !== PCB_NATIVE_NUMERIC_RULE_MODE) throw new Error("Unsupported contract-native numeric rule mode.");
  const nets = contract.nets.map(net => {
    const netClass = contract.netClasses.find(entry => entry.id === net.netClassId)!;
    if (netClass === undefined) throw new Error("Native numeric rules require an exact declared net class.");
    const channel = channelForNet(contract, net.name);
    const minima = channel?.channel === undefined ? [netClass.traceWidthMm] : [channel.geometry.traceWidthMm.minimumMm,
      ...channel.channel.escapes.filter(escape => net.endpoints.some(point => point.reference === escape.terminal.reference && point.pin === escape.terminal.pin))
        .map(escape => escape.traceWidthMm.minimumMm)];
    return Object.freeze({ name: net.name, minimumTrackWidthMm: Math.min(...minima.map(exact)),
      preferredTrackWidthMm: exact(netClass.traceWidthMm), copperToEdgeMm: exact(netClass.copperToEdgeMm) });
  });
  const policy = contract.routingConstraints.viaPolicy;
  const via = policy.mode === "forbidden" ? undefined : Object.freeze({ diameterMm: exact(policy.diameterMm),
    drillMm: exact(policy.drillMm), minimumAnnularRingMm: exact(policy.minimumAnnularRingMm) });
  const boardRules: PcbNativeBoardRules = Object.freeze({ ...defaults,
    min_hole_to_hole: exact(contract.routingConstraints.minimumHoleToHoleMm ?? defaults.min_hole_to_hole),
    min_track_width: Math.min(defaults.min_track_width, ...nets.map(net => net.minimumTrackWidthMm)),
    min_copper_edge_clearance: Math.min(defaults.min_copper_edge_clearance, ...nets.map(net => net.copperToEdgeMm)),
    ...(via === undefined ? {} : { min_through_hole_diameter: Math.min(defaults.min_through_hole_diameter, via.drillMm),
      min_via_annular_width: Math.min(defaults.min_via_annular_width, via.minimumAnnularRingMm),
      min_via_diameter: Math.min(defaults.min_via_diameter, via.diameterMm) }) });
  return Object.freeze({ boardRules, requiredNativeCheckSeverities, nets: Object.freeze(nets), via });
}

/** Called on actual captured settings before materialization/readback/native assessment; never repairs drift. */
export function assertPcbNativeNumericProjectSettings(contract: PcbPlaneDesignContract, settings: unknown): void {
  const derived = derivePcbNativeNumericRules(contract);
  if (derived === undefined) return;
  const object = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Contract-native numeric project settings are missing or malformed.");
    return value as Record<string, unknown>;
  };
  const design = object(object(object(settings).board).design_settings), rules = object(design.rules);
  for (const [key, expected] of Object.entries(derived.boardRules)) if (rules[key] !== expected || Object.is(rules[key], -0)) {
    throw new Error(`Contract-native numeric rule ${key} differs from its exact V2 projection.`);
  }
  const severities = object(design.rule_severities);
  for (const [key, expected] of Object.entries(derived.requiredNativeCheckSeverities)) if (severities[key] !== expected) {
    throw new Error(`Contract-native numeric check ${key} must retain error severity.`);
  }
  // The pinned KiCad 10.0.3 saved defaults omit via_diameter, but native
  // qualification observes an error for a violated custom diameter minimum.
  // Only that absent default or an explicit error is admitted; ignored native
  // report metadata is independently refused by the native assessor.
  if (Object.hasOwn(severities, "via_diameter") && severities.via_diameter !== "error") throw new Error("Contract-native numeric check via_diameter must retain its qualified error severity.");
}

/** Rules are ordered from preserved defaults to exact contract exceptions.
 * KiCad resolves the last applicable custom constraint of each type. */
export function pcbNativeNumericRuleLines(contract: PcbPlaneDesignContract): readonly string[] {
  const derived = derivePcbNativeNumericRules(contract);
  if (derived === undefined) return [];
  const lines = ["", '(rule "EVLEDA_NUMERIC_FALLBACK"', '  (severity error)',
    '  (constraint track_width (min 0.2mm))', '  (constraint edge_clearance (min 0.5mm)))',
    "", '(rule "EVLEDA_NUMERIC_PAD_FALLBACK"', '  (condition "A.Type == \'Pad\'")', '  (severity error)',
    '  (constraint hole_size (min 0.3mm))', '  (constraint annular_width (min 0.1mm)))'];
  for (const [index, net] of derived.nets.entries()) {
    // The shared contract net-name grammar excludes quoting, slash escapes and
    // wildcard syntax. Check independently before constructing a native expression.
    if (!/^[A-Za-z0-9+-][A-Za-z0-9_.+-]{0,63}$/u.test(net.name)) throw new Error("Contract net name is outside exact native numeric rule expression syntax.");
    lines.push("", `(rule "EVLEDA_NUMERIC_NET_${index + 1}"`, `  (condition "A.NetName == '${net.name}'")`, '  (severity error)',
      `  (constraint track_width (min ${net.minimumTrackWidthMm}mm))`, `  (constraint edge_clearance (min ${net.copperToEdgeMm}mm)))`);
  }
  if (derived.via !== undefined) lines.push("", '(rule "EVLEDA_NUMERIC_VIA"', '  (condition "A.Type == \'Via\'")', '  (severity error)',
    `  (constraint via_diameter (min ${derived.via.diameterMm}mm))`, `  (constraint hole_size (min ${derived.via.drillMm}mm))`,
    `  (constraint annular_width (min ${derived.via.minimumAnnularRingMm}mm)))`);
  return Object.freeze(lines);
}

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
  analyzeKicadPcbPractices,
  type PcbPracticeAnalysis,
  type PcbPracticeAnalysisProfile,
} from "../integrations/pcb-practice-analyzer.js";
import type { HarnessToolResult } from "./contracts.js";
import {
  LED_INDICATOR_EXAMPLE,
  parseFreshLedIndicatorContract,
  type FreshLedIndicatorContract,
} from "./fresh-project.js";
import {
  FreshKicadParseError,
  parseFreshPcbSource,
  parseFreshSchematicSource,
  type FreshParsedPcb,
  type FreshPoint,
} from "./fresh-kicad-parser.js";

export const freshAcceptanceStatusSchema = z.enum(["pass", "fail", "unknown"]);
const requirementSchema = z.object({ id: z.string(), status: freshAcceptanceStatusSchema, detail: z.string() }).strict();
export const freshAcceptanceResultSchema = z.object({
  passed: z.boolean(), requirements: z.array(requirementSchema), missing: z.array(z.string()),
  sourceHashes: z.object({
    schematicSha256: z.string().regex(/^[a-f0-9]{64}$/u), pcbSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  evidenceLimitations: z.array(z.string()),
}).strict();
export type FreshAcceptanceResult = z.infer<typeof freshAcceptanceResultSchema>;
export type FreshAcceptanceStatus = z.infer<typeof freshAcceptanceStatusSchema>;

export interface LedIndicatorAcceptanceEvidence {
  readonly schematicSource: string;
  readonly pcbSource: string;
  readonly schematicPath?: string;
  readonly pcbPath?: string;
  readonly connectivity: string | HarnessToolResult;
  readonly erc: string | HarnessToolResult;
  readonly drc: string | HarnessToolResult;
  readonly visualInspection: string | HarnessToolResult;
}

/** Geometry-matching tolerance only; never a PCB design requirement. */
export const FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM = 0.0001;
/** Floating-point angle comparison tolerance only; contract intent remains exact. */
export const FRESH_ACCEPTANCE_ANGLE_TOLERANCE_DEG = 0.01;
/** Analyzer-only tolerance for recognizing a nominal 90-degree classifier bucket. */
export const FRESH_ACCEPTANCE_RIGHT_ANGLE_CLASSIFICATION_TOLERANCE_DEG = 0.01;
const NUMERIC_EPSILON = 1e-9;

const row = (id: string, status: FreshAcceptanceStatus, detail: string) => ({ id, status, detail });
const sha256 = (source: string): string => createHash("sha256").update(source, "utf8").digest("hex");
const sorted = (values: readonly string[]): readonly string[] => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const sameStrings = (a: readonly string[], b: readonly string[]): boolean => {
  const left = sorted(a); const right = sorted(b);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
};
const close = (a: FreshPoint, b: FreshPoint): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM;

function rawContent(value: string | HarnessToolResult): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value : null;
  return value.isError === true || value.content.trim().length === 0 ? null : value.content;
}

function jsonRecord(value: string | HarnessToolResult): Record<string, unknown> | null {
  const content = rawContent(value);
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function connectivityGroups(value: string | HarnessToolResult): ReadonlyMap<string, readonly string[]> | null {
  const content = rawContent(value);
  if (content === null) return null;
  const record = jsonRecord(value);
  const text = record !== null && typeof record.result === "string" ? record.result : content;
  const header = /^Connectivity groups \((\d+) total\):$/mu.exec(text);
  if (header === null) return null;
  const matches = [...text.matchAll(/^- Group \d+: ([^|\r\n]+?)\s*\|\s*pins=([^|\r\n]*?)\s*\|\s*points=\d+\s*$/gmu)];
  if (matches.length !== Number(header[1])) return null;
  const groups = new Map<string, readonly string[]>();
  for (const match of matches) {
    const name = match[1]!.trim();
    const pins = match[2]!.split(/[\s,]+/u).map((pin) => pin.trim()).filter(Boolean);
    if (groups.has(name) || pins.length === 0 || new Set(pins).size !== pins.length) return null;
    groups.set(name, Object.freeze(sorted(pins)));
  }
  return groups;
}

function explicitValidatorWithinContract(
  value: string | HarnessToolResult,
  kind: "erc" | "drc",
  policy: FreshLedIndicatorContract["acceptance"]["native"]["erc"] | FreshLedIndicatorContract["acceptance"]["native"]["drc"],
): boolean | null {
  const record = jsonRecord(value);
  if (record === null) return null;
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  const metadata = record.metadata !== null && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown> : null;
  if (metadata === null || policy.availableRequired && metadata.available !== true || !policy.acceptedStatuses.includes(status as "clean" | "pass" | "passed")) return false;
  const count = kind === "erc" ? metadata.violation_count : metadata.violations;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  if (count > policy.maximumViolations) return false;
  if (kind === "drc") {
    const drcPolicy = policy as FreshLedIndicatorContract["acceptance"]["native"]["drc"];
    const checks = [["unconnected_items", drcPolicy.maximumUnconnectedItems], ["courtyard_issues", drcPolicy.maximumCourtyardIssues]] as const;
    for (const [key, maximum] of checks) {
      if (typeof metadata[key] !== "number" || !Number.isSafeInteger(metadata[key] as number) || (metadata[key] as number) < 0) return null;
      if ((metadata[key] as number) > maximum) return false;
    }
  }
  return true;
}

function explicitVisualWithinContract(
  value: string | HarnessToolResult,
  policy: FreshLedIndicatorContract["acceptance"]["native"]["visualPractice"],
): boolean | null {
  const record = jsonRecord(value);
  if (record === null || !Array.isArray(record.findings)) return null;
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  if (!policy.acceptedStatuses.includes(status as "clean" | "pass" | "passed")) return false;
  return record.findings.length <= policy.maximumFindings;
}

function analyzerProfile(version: number, contract: FreshLedIndicatorContract): PcbPracticeAnalysisProfile {
  const exactNetNames = contract.schematic.exactNets.map((net) => net.name);
  const detection = contract.routing.forbiddenGeometryDetection;
  return {
    schemaVersion: PCB_PRACTICE_ANALYSIS_PROFILE_SCHEMA,
    sourceValidation: { mode: "production", supportedBoardVersions: [version] },
    copperLayerOrder: ["F.Cu", "B.Cu"],
    netClasses: [{
      id: "canary", sourceRuleId: "fresh.canary.trace-width", severity: "error", gates: ["human-review"],
      minimumTrackWidthMm: contract.routing.minimumWidthMm,
      minimumInteriorAngleDeg: 180 - contract.routing.maximumDirectionChangeDeg - FRESH_ACCEPTANCE_ANGLE_TOLERANCE_DEG,
      interiorAngleDisposition: { sourceRuleId: "fresh.canary.maximum-turn", severity: "error", gates: ["human-review"] },
    }],
    netClassByNet: Object.fromEntries(exactNetNames.map((name) => [name, "canary"])),
    viaRules: [],
    advisories: {
      rightAngle: { sourceRuleId: "fresh.canary.no-right-angle", toleranceDeg: FRESH_ACCEPTANCE_RIGHT_ANGLE_CLASSIFICATION_TOLERANCE_DEG },
      reversal: { sourceRuleId: "fresh.canary.no-reversal", maximumInteriorAngleDeg: detection.reversalMaximumInteriorAngleDeg },
      adjacentHairpin: {
        sourceRuleId: "fresh.canary.no-overlap", parallelToleranceDeg: detection.hairpin.parallelToleranceDeg,
        maximumLegEdgeGapMm: detection.hairpin.maximumLegEdgeGapMm,
        minimumParallelOverlapMm: detection.hairpin.minimumParallelOverlapMm,
        maximumConnectorPathLengthMm: detection.hairpin.maximumConnectorPathLengthMm,
      },
    },
    diagnostics: {
      invalidGeometrySourceRuleId: "fresh.native-geometry", unboundNetSourceRuleId: "fresh.exact-net-binding",
      unsupportedOutlineSourceRuleId: "fresh.outline-coverage", unsupportedRoutingSourceRuleId: "fresh.routing-coverage",
      junctionCoverageSourceRuleId: "fresh.turn-junction-coverage", containmentSourceRuleId: "fresh.board-containment",
      duplicateTrackSourceRuleId: "fresh.no-duplicate-tracks",
    },
    coordinateToleranceMm: FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM,
  };
}

interface Check { readonly status: FreshAcceptanceStatus; readonly detail: string }

function routedConnectivity(board: FreshParsedPcb, contract: FreshLedIndicatorContract): Check {
  const expectedNets: Readonly<Record<string, readonly string[]>> = Object.fromEntries(contract.schematic.exactNets.map((net) => [net.name, net.endpoints]));
  const expectedNames = Object.keys(expectedNets);
  if (board.segments.some((segment) => segment.netName === null)) return { status: "unknown", detail: "At least one routed segment has no resolvable net identity." };
  if (board.segments.some((segment) => !expectedNames.includes(segment.netName!))) return { status: "fail", detail: "A routed segment belongs to a net outside the closed canary net set." };
  if (board.segments.some((segment) => segment.layer !== contract.routing.requiredLayer)) return { status: "fail", detail: `A required route contains copper outside ${contract.routing.requiredLayer}.` };
  const padByEndpoint = new Map<string, { readonly at: FreshPoint; readonly netName: string | null }>();
  for (const footprint of board.footprints) for (const pad of footprint.pads) {
    const endpoint = `${footprint.reference}:${pad.number}`;
    if (padByEndpoint.has(endpoint)) return { status: "fail", detail: `PCB pad endpoint ${endpoint} is duplicated.` };
    padByEndpoint.set(endpoint, { at: pad.at, netName: pad.netName });
  }
  for (const [netName, endpoints] of Object.entries(expectedNets)) {
    const pads = endpoints.map((endpoint) => padByEndpoint.get(endpoint));
    if (pads.some((pad) => pad === undefined)) return { status: "fail", detail: `${netName} lacks one or more required PCB pads.` };
    if (pads.some((pad) => pad!.netName === null)) return { status: "unknown", detail: `${netName} has a required pad without resolvable net evidence.` };
    if (pads.some((pad) => pad!.netName !== netName)) return { status: "fail", detail: `${netName} has a required pad assigned to the wrong PCB net.` };
    const padPoints = pads.map((pad) => pad!.at);
    const segments = board.segments.filter((segment) => segment.netName === netName);
    if (contract.routing.everyExactNetMustBeRouted && segments.length === 0) return { status: "fail", detail: `${netName} has no routed copper segments.` };
    if (segments.length === 0) continue;
    const points: FreshPoint[] = [...padPoints, ...segments.flatMap((segment) => [segment.start, segment.end])];
    const parent = points.map((_point, index) => index);
    const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
    const join = (left: number, right: number): void => { const a = find(left); const b = find(right); if (a !== b) parent[b] = a; };
    for (let left = 0; left < points.length; left += 1) for (let right = left + 1; right < points.length; right += 1) {
      if (close(points[left]!, points[right]!)) join(left, right);
    }
    const padCount = padPoints.length;
    segments.forEach((_segment, index) => join(padCount + index * 2, padCount + index * 2 + 1));
    if (!padPoints.every((_point, index) => find(index) === find(0))) return { status: "fail", detail: `${netName} required pads are not one routed connected component.` };
    for (let index = padCount; index < points.length; index += 1) {
      const coincidentPeers = points.filter((candidate, candidateIndex) => candidateIndex !== index && close(points[index]!, candidate)).length;
      if (coincidentPeers < 1 && contract.routing.danglingTrackEndpoints === 0) return { status: "fail", detail: `${netName} has a dangling track endpoint not coincident with a pad or adjacent track.` };
    }
  }
  return { status: "pass", detail: "All exact required PCB pads are joined per net by endpoint-coincident routed segments with no dangling endpoint." };
}

function connectorPlacement(board: FreshParsedPcb, contract: FreshLedIndicatorContract): Check {
  const outline = board.outlineBounds;
  const placement = contract.placement.connector;
  const connector = board.footprints.find((footprint) => footprint.reference === placement.reference);
  if (outline === null || connector === undefined || connector.courtyardBounds === null || connector.bodyBounds === null) {
    return { status: "unknown", detail: `${placement.reference} outline, courtyard, or body geometry is unavailable.` };
  }
  const boxes = [connector.courtyardBounds, connector.bodyBounds];
  const inside = !placement.bodyAndCourtyardInsideBoard || boxes.every((box) =>
    box.minX >= outline.minX - FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM && box.maxX <= outline.maxX + FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM &&
    box.minY >= outline.minY - FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM && box.maxY <= outline.maxY + FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM
  );
  const clearance = (box: NonNullable<typeof connector.bodyBounds>): number => ({
    left: box.minX - outline.minX, top: box.minY - outline.minY,
    right: outline.maxX - box.maxX, bottom: outline.maxY - box.maxY,
  })[placement.edge];
  const courtyardClearance = clearance(connector.courtyardBounds);
  const bodyClearance = clearance(connector.bodyBounds);
  const rotation = ((connector.rotationDeg % 360) + 360) % 360;
  const rotationDelta = Math.abs(rotation - placement.rotationDeg);
  const outward = !placement.localMinusXFacesOutward || Math.min(rotationDelta, 360 - rotationDelta) <= FRESH_ACCEPTANCE_ANGLE_TOLERANCE_DEG;
  const near = courtyardClearance >= -FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM && courtyardClearance <= placement.maximumEdgeClearanceMm + FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM && bodyClearance <= placement.maximumEdgeClearanceMm + FRESH_ACCEPTANCE_COORDINATE_TOLERANCE_MM;
  return inside && near && outward
    ? { status: "pass", detail: `${placement.reference} courtyard/body are ${placement.bodyAndCourtyardInsideBoard ? "inside" : "reviewed at"} and within ${placement.maximumEdgeClearanceMm.toFixed(2)} mm of ${placement.edge} edge; rotation ${rotation.toFixed(3)} deg matches contract.` }
    : { status: "fail", detail: `${placement.reference} edge/orientation mismatch: courtyard clearance ${courtyardClearance.toFixed(3)} mm, body clearance ${bodyClearance.toFixed(3)} mm, rotation ${rotation.toFixed(3)} deg; required ${placement.edge} edge at ${placement.rotationDeg} deg.` };
}

/** Closed LED helper contract. Missing, malformed, or unsupported evidence is never a pass. */
export function evaluateLedIndicatorAcceptance(
  evidence: LedIndicatorAcceptanceEvidence,
  contractInput: unknown = LED_INDICATOR_EXAMPLE,
): FreshAcceptanceResult {
  const contract = parseFreshLedIndicatorContract(contractInput);
  const expectedSymbols = contract.components.map((component) => [component.reference, component.symbolId, component.value, component.footprintId] as const);
  const expectedNets: Readonly<Record<string, readonly string[]>> = Object.fromEntries(contract.schematic.exactNets.map((net) => [net.name, net.endpoints]));
  const expectedFootprints = new Map(contract.components.map((component) => [component.reference, component.footprintId]));
  const mandatoryIds = new Set<string>(contract.acceptance.mandatoryRows);
  const sourceHashes = { schematicSha256: sha256(evidence.schematicSource), pcbSha256: sha256(evidence.pcbSource) };
  let schematic: ReturnType<typeof parseFreshSchematicSource> | null = null;
  let board: FreshParsedPcb | null = null;
  let schematicProblem = "";
  let boardProblem = "";
  try { schematic = parseFreshSchematicSource(evidence.schematicSource); }
  catch (error) { schematicProblem = error instanceof FreshKicadParseError ? error.message : "Schematic source parsing failed unexpectedly."; }
  try { board = parseFreshPcbSource(evidence.pcbSource); }
  catch (error) { boardProblem = error instanceof FreshKicadParseError ? error.message : "PCB source parsing failed unexpectedly."; }
  let analysis: PcbPracticeAnalysis | null = null;
  let analysisProblem = "";
  if (board?.version !== null && board?.version !== undefined) {
    try { analysis = analyzeKicadPcbPractices(evidence.pcbSource, analyzerProfile(board.version, contract), { sourcePath: evidence.pcbPath ?? "<fresh.kicad_pcb>" }); }
    catch (error) { analysisProblem = error instanceof Error ? error.message : "PCB practice analysis failed."; }
  } else analysisProblem = "PCB version is unavailable.";

  const requirements: Array<ReturnType<typeof row>> = [];
  if (schematic === null) {
    requirements.push(row("symbols", "unknown", schematicProblem || "Schematic source unavailable."), row("no-connect", "unknown", schematicProblem || "Schematic source unavailable."));
  } else {
    const actual = schematic.symbols.map((symbol) => [symbol.reference, symbol.libId, symbol.value, symbol.footprint].join("|"));
    const expected = expectedSymbols.map((symbol) => symbol.join("|"));
    const symbolsPass = sameStrings(actual, expected);
    const references = contract.components.map((component) => component.reference).join("/");
    requirements.push(row("symbols", symbolsPass ? "pass" : "fail", symbolsPass ? `Exact ${references} references, library IDs, values, and footprints match.` : `Exact schematic symbol inventory mismatch: ${actual.join(", ") || "empty"}.`));
    const noConnectPass = schematic.noConnectCount === contract.schematic.noConnectMarkers;
    requirements.push(row("no-connect", noConnectPass ? "pass" : "fail", noConnectPass ? `Schematic has the contract-required ${contract.schematic.noConnectMarkers} no-connect marker(s).` : `Schematic has ${schematic.noConnectCount} no-connect marker(s); contract requires ${contract.schematic.noConnectMarkers}.`));
  }

  const groups = connectivityGroups(evidence.connectivity);
  const connectivityPass = groups !== null && groups.size === Object.keys(expectedNets).length && Object.entries(expectedNets).every(([name, endpoints]) => sameStrings(groups.get(name) ?? [], endpoints));
  const exactNetNames = Object.keys(expectedNets);
  requirements.push(row("schematic-nets", groups === null ? "unknown" : connectivityPass ? "pass" : "fail", groups === null ? "Connectivity readback did not expose the supported exact group syntax." : connectivityPass ? `Exact ${exactNetNames.join(", ")} endpoint sets and declared LED polarity match.` : `Connectivity groups mismatch: ${[...groups].map(([name, pins]) => `${name}=[${pins.join(",")}]`).join("; ")}.`));

  if (board === null) {
    for (const id of ["pcb-sync-footprints", "outline", "j1-edge-orientation", "routed-connectivity", "trace-width", "track-turns", "vias", "gnd-zone"] as const) requirements.push(row(id, "unknown", boardProblem || "PCB source unavailable."));
  } else {
    const expectedValueByReference = new Map<string, string>(expectedSymbols.map(([reference, , value]) => [reference, value]));
    for (const symbol of schematic?.symbols ?? []) expectedValueByReference.set(symbol.reference, symbol.value);
    const actualFootprints = board.footprints.map((footprint) => `${footprint.reference}|${footprint.libraryId}|${footprint.value}`);
    const expectedPcbFootprints = [...expectedFootprints].map(([reference, libraryId]) => `${reference}|${libraryId}|${expectedValueByReference.get(reference)!}`);
    const expectedEndpoints = sorted(Object.values(expectedNets).flat());
    const actualEndpoints = sorted(board.footprints.flatMap((footprint) => footprint.pads.map((pad) => `${footprint.reference}:${pad.number}`)));
    const footprintsPass = sameStrings(actualFootprints, expectedPcbFootprints) && sameStrings(actualEndpoints, expectedEndpoints) &&
      board.footprints.every((footprint) => footprint.layer === contract.placement.allFootprintsOn);
    requirements.push(row("pcb-sync-footprints", footprintsPass ? "pass" : "fail", footprintsPass ? `PCB has exactly ${contract.components.length} schematic-synchronized footprints with exact identities, values, pads, and ${contract.placement.allFootprintsOn} placement.` : `Exact PCB footprint inventory/value/pad/layer mismatch: ${actualFootprints.join(", ") || "empty"}.`));

    const dimensions = board.outlineBounds === null ? null : { width: board.outlineBounds.maxX - board.outlineBounds.minX, height: board.outlineBounds.maxY - board.outlineBounds.minY };
    const outlineComplete = !contract.board.completeOutlineRequired || analysis?.summary.outlineComplete === true;
    const outlinePass = board.outlineSupported && dimensions !== null && outlineComplete &&
      Math.abs(dimensions.width - contract.board.widthMm) <= contract.board.dimensionToleranceMm &&
      Math.abs(dimensions.height - contract.board.heightMm) <= contract.board.dimensionToleranceMm;
    requirements.push(row("outline", dimensions === null || analysis === null ? "unknown" : outlinePass ? "pass" : "fail", dimensions === null ? "Supported Edge.Cuts line/rectangle outline evidence is unavailable." : analysis === null ? `Practice-analyzer outline evidence unavailable: ${analysisProblem}` : `Outline is ${dimensions.width.toFixed(3)} x ${dimensions.height.toFixed(3)} mm; required ${contract.board.widthMm.toFixed(2)} +/-${contract.board.dimensionToleranceMm.toFixed(2)} x ${contract.board.heightMm.toFixed(2)} +/-${contract.board.dimensionToleranceMm.toFixed(2)} mm${contract.board.completeOutlineRequired ? " and complete" : ""}.`));

    const placement = connectorPlacement(board, contract); requirements.push(row("j1-edge-orientation", placement.status, placement.detail));
    const routing = routedConnectivity(board, contract); requirements.push(row("routed-connectivity", routing.status, routing.detail));
    const requiredSegments = board.segments.filter((segment) => segment.netName !== null && Object.hasOwn(expectedNets, segment.netName));
    const widthKnown = requiredSegments.length > 0 && (!contract.routing.everyExactNetMustBeRouted || exactNetNames.every((name) => requiredSegments.some((segment) => segment.netName === name)));
    const widthPass = widthKnown && requiredSegments.every((segment) => segment.widthMm + NUMERIC_EPSILON >= contract.routing.minimumWidthMm);
    requirements.push(row("trace-width", widthKnown ? widthPass ? "pass" : "fail" : "unknown", widthKnown ? widthPass ? `Every segment on ${exactNetNames.join(", ")} is at least ${contract.routing.minimumWidthMm.toFixed(2)} mm wide.` : `At least one required-net segment is below ${contract.routing.minimumWidthMm.toFixed(2)} mm.` : "One or more required nets has no width-bearing segment evidence."));

    const findingCodesByProhibition: Readonly<Record<FreshLedIndicatorContract["routing"]["forbidden"][number], readonly string[]>> = {
      reversal: ["CONNECTED_REVERSAL_CANDIDATE", "ADJACENT_PARALLEL_HAIRPIN_CANDIDATE"],
      "duplicate-track": ["DUPLICATE_ROUTED_TRACK"], overlap: ["OVERLAPPING_ROUTED_TRACKS"],
    };
    const forbiddenCodes = new Set(contract.routing.forbidden.flatMap((prohibition) => findingCodesByProhibition[prohibition]));
    const coverageKnown = analysis !== null && (!contract.routing.completeCoverageRequired || analysis.summary.routingCoverageComplete);
    const maximumObservedTurnDeg = contract.routing.maximumDirectionChangeDeg + FRESH_ACCEPTANCE_ANGLE_TOLERANCE_DEG;
    const turnPass = coverageKnown && analysis!.extracted.turns.every((turn) => turn.directionChangeDeg <= maximumObservedTurnDeg + NUMERIC_EPSILON) && !analysis!.findings.some((finding) => forbiddenCodes.has(finding.code));
    requirements.push(row("track-turns", analysis === null || !coverageKnown ? "unknown" : turnPass ? "pass" : "fail", analysis === null ? `Practice-analyzer turn evidence unavailable: ${analysisProblem}` : !coverageKnown ? "Practice analyzer reports incomplete routing/turn coverage required by the contract." : turnPass ? `Every covered adjacent track direction change is <=${contract.routing.maximumDirectionChangeDeg.toFixed(2)} deg plus ${FRESH_ACCEPTANCE_ANGLE_TOLERANCE_DEG.toFixed(2)} deg evaluator tolerance, with no contract-forbidden ${contract.routing.forbidden.join(", ") || "geometry"}.` : `A covered direction change exceeds the contract maximum or contract-forbidden ${contract.routing.forbidden.join(", ")} was detected.`));

    const viaPass = analysis !== null && board.viaCount <= contract.routing.maximumViaCount && analysis.summary.viaCount <= contract.routing.maximumViaCount;
    requirements.push(row("vias", analysis === null ? "unknown" : viaPass ? "pass" : "fail", analysis === null ? `Practice-analyzer via evidence unavailable: ${analysisProblem}` : `${board.viaCount} parsed via(s), ${analysis.summary.viaCount} analyzer via(s); contract maximum ${contract.routing.maximumViaCount}.`));

    const groundZone = contract.zones.ground;
    const zonePresent = board.zoneNetNames.includes(groundZone.netName);
    const zonePass = groundZone.policy === "optional" || groundZone.policy === "required" && zonePresent || groundZone.policy === "forbidden" && !zonePresent;
    requirements.push(row("gnd-zone", zonePass ? "pass" : "fail", `${groundZone.netName} zone is ${zonePresent ? "present" : "absent"}; contract policy is ${groundZone.policy}, add-only-if-safe=${groundZone.addOnlyIfSafe}, substitutes-for-routing=${groundZone.substitutesForRoutedConnectivity}.`));
  }

  const ercPolicy = contract.acceptance.native.erc;
  const erc = explicitValidatorWithinContract(evidence.erc, "erc", ercPolicy);
  requirements.push(row("erc", erc === null ? "unknown" : erc ? "pass" : "fail", erc === null ? "ERC result lacks the contract-required explicit count evidence." : erc ? `Native ERC status/count meet the contract maximum of ${ercPolicy.maximumViolations} violation(s).` : "Native ERC status, availability, or violation count does not meet the contract."));
  const drcPolicy = contract.acceptance.native.drc;
  const drc = explicitValidatorWithinContract(evidence.drc, "drc", drcPolicy);
  requirements.push(row("drc", drc === null ? "unknown" : drc ? "pass" : "fail", drc === null ? "DRC result lacks the contract-required explicit violation/unconnected/courtyard counts." : drc ? `Native DRC counts meet contract maxima: violations ${drcPolicy.maximumViolations}, unconnected ${drcPolicy.maximumUnconnectedItems}, courtyard ${drcPolicy.maximumCourtyardIssues}.` : "Native DRC status, availability, or counts do not meet the contract."));
  const visualPolicy = contract.acceptance.native.visualPractice;
  const visual = explicitVisualWithinContract(evidence.visualInspection, visualPolicy);
  const analyzerBlocking = analysis === null ? null : analysis.findings.filter((finding) => finding.severity !== "advisory" || finding.gates.length > 0);
  const visualPracticePass = visual === true && analyzerBlocking !== null && analyzerBlocking.length <= visualPolicy.maximumBlockingPracticeFindings;
  requirements.push(row("visual-practice", visual === null || analyzerBlocking === null ? "unknown" : visualPracticePass ? "pass" : "fail", visual === null ? "Visual inspection lacks the contract-required explicit status/findings evidence." : analyzerBlocking === null ? `PCB practice analysis unavailable: ${analysisProblem}` : visualPracticePass ? `Visual and covered-geometry findings meet contract maxima (${visualPolicy.maximumFindings}/${visualPolicy.maximumBlockingPracticeFindings}).` : `Visual/practice review exceeds a contract maximum (${analyzerBlocking.length} blocking analyzer finding(s)).`));

  const missing = requirements.filter((requirement) => mandatoryIds.has(requirement.id) && requirement.status !== "pass").map((requirement) => `${requirement.id} [${requirement.status}]: ${requirement.detail}`);
  return freshAcceptanceResultSchema.parse({
    passed: missing.length === 0, requirements, missing, sourceHashes,
    evidenceLimitations: [
      "pcb-practice-analyzer completeBoardGeometryCoverage is always false by contract; this gate uses the task contract's covered-routing requirement and separately resolves exact pads, segments, vias, and outline.",
      "Current native ERC/DRC payloads expose report paths and counts but no source-content hash; ordering after save plus these frozen source hashes is the strongest available binding.",
      `${contract.placement.connector.reference} outward orientation follows the validated contract convention: ${contract.placement.connector.edge} edge, ${contract.placement.connector.rotationDeg} deg, local -X outward=${contract.placement.connector.localMinusXFacesOutward}.`,
    ],
  });
}

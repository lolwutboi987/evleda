import { parseFreshPcbSource, type FreshReferenceSegment } from "./fresh-kicad-parser.js";
import { routeSourceMmToNativeNm } from "./fresh-route-native-units.js";

type Endpoint = { readonly reference: string; readonly pin: string };
export interface ReferenceTerminalLaunchProposal {
  readonly signalEndpoint: Endpoint;
  readonly referenceEndpoint: Endpoint;
  readonly maximumLengthNm: number;
  readonly maximumReturnSpacingNm: number;
  readonly engineeringBasis: string;
}
export class ReferenceTerminalLaunchPlanningError extends Error {
  constructor(message: string, readonly disposition: "unsupported" | "constraint" = "unsupported") { super(`Terminal launch study: ${message}`); }
}
const check = (v: unknown, message: string, disposition: "unsupported" | "constraint" = "unsupported"): void => {
  if (!v) throw new ReferenceTerminalLaunchPlanningError(message, disposition);
};
const sqrtFloor = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};

/** Prospective source-only projection, never an exception to bound requirements.
 * The caller must keep the original full-ribbon result and check source stability
 * after both calculations. No supplied centre, segment geometry or copper is used. */
export function planReferenceTerminalLaunchStudy(input: {
  readonly pcbSource: string;
  readonly segments: readonly FreshReferenceSegment[];
  readonly referenceNet: string;
  readonly proposals: readonly ReferenceTerminalLaunchProposal[];
}) {
  check(input.proposals.length > 0 && input.proposals.length <= 4, "proposal inventory bound");
  const board = parseFreshPcbSource(input.pcbSource), replacements = new Map<string, FreshReferenceSegment>();
  const launches = input.proposals.map(proposal => {
    const { signalEndpoint, referenceEndpoint, maximumLengthNm, maximumReturnSpacingNm } = proposal;
    check(Number.isSafeInteger(maximumLengthNm) && maximumLengthNm > 0 && maximumLengthNm <= 3_000_000, "launch length bound");
    check(Number.isSafeInteger(maximumReturnSpacingNm) && maximumReturnSpacingNm > 0 && maximumReturnSpacingNm <= 5_000_000, "return spacing bound");
    check(signalEndpoint.reference === referenceEndpoint.reference && signalEndpoint.pin !== referenceEndpoint.pin, "distinct signal and return pins on the same footprint required");
    const footprints = board.footprints.filter(f => f.reference === signalEndpoint.reference);
    check(footprints.length === 1, "unique source footprint required");
    const footprint = footprints[0]!;
    check(footprint.layer === "F.Cu", "only front-side terminal footprints supported");
    const angle = (footprint.rotationDeg % 360 + 360) % 360;
    check([0, 90, 180, 270].includes(angle), "only exact cardinal footprint poses supported");
    const locate = (endpoint: Endpoint) => {
      const matches = footprint.pads.filter(p => p.number === endpoint.pin);
      check(matches.length === 1, "one complete physical pad per terminal required");
      const pad = matches[0]!, physical = pad.physical;
      check(physical.id !== null && physical.padType === "thru_hole" && ["circle", "rect"].includes(physical.shape ?? "")
        && pad.layers.includes("*.Cu") && physical.relativeAt !== null && physical.drill?.shape === "circle"
        && physical.drill.offsetMm === null, "ordinary centred through-hole pad required");
      const x = routeSourceMmToNativeNm(physical.relativeAt!.x), y = routeSourceMmToNativeNm(physical.relativeAt!.y);
      const rotated = angle === 0 ? { x, y } : angle === 90 ? { x: y, y: -x }
        : angle === 180 ? { x: -x, y: -y } : { x: -y, y: x };
      const center = { x: routeSourceMmToNativeNm(footprint.at.x) + rotated.x, y: routeSourceMmToNativeNm(footprint.at.y) + rotated.y };
      check([center.x, center.y].every(v => Number.isSafeInteger(v) && Math.abs(v) <= 2_000_000_000), "derived centre bound");
      return { pad, center };
    };
    const signal = locate(signalEndpoint), reference = locate(referenceEndpoint);
    check(signal.pad.physical.id !== reference.pad.physical.id, "signal and return physical identities must differ");
    check(reference.pad.netName === input.referenceNet && signal.pad.netName !== input.referenceNet, "source signal/return nets differ from the selection");
    const spacingSquared = BigInt(signal.center.x - reference.center.x) ** 2n + BigInt(signal.center.y - reference.center.y) ** 2n;
    check(spacingSquared <= BigInt(maximumReturnSpacingNm) ** 2n, "return pin exceeds the proposed spacing bound", "constraint");
    const equals = (p: { x: number; y: number }) => p.x === signal.center.x && p.y === signal.center.y;
    const incident = input.segments.filter(s => s.netName === signal.pad.netName && (equals(s.startNm) || equals(s.endNm)));
    check(incident.length === 1, "exactly one selected straight segment must end at the signal-pad centre");
    const segment = incident[0]!;
    check(!replacements.has(segment.uuid), "overlapping proposals on the same segment are unsupported");
    const other = equals(segment.startNm) ? segment.endNm : segment.startNm;
    const dx = other.x - signal.center.x, dy = other.y - signal.center.y;
    check((dx !== 0 || dy !== 0) && (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)), "straight/cardinal/45-degree terminal segment required");
    const step = Number(sqrtFloor(BigInt(maximumLengthNm) ** 2n / (dx !== 0 && dy !== 0 ? 2n : 1n)));
    check(step > 0 && step < Math.max(Math.abs(dx), Math.abs(dy)), "proposal must leave a nonzero segment remainder");
    const cut = { x: signal.center.x + Math.sign(dx) * step, y: signal.center.y + Math.sign(dy) * step };
    const removedLengthSquaredNm = BigInt(cut.x - signal.center.x) ** 2n + BigInt(cut.y - signal.center.y) ** 2n;
    check(removedLengthSquaredNm <= BigInt(maximumLengthNm) ** 2n, "projection exceeds its declared length");
    replacements.set(segment.uuid, { ...segment, startNm: equals(segment.startNm) ? cut : segment.startNm,
      endNm: equals(segment.endNm) ? cut : segment.endNm });
    return { signalEndpoint, referenceEndpoint, signalPadUuid: signal.pad.physical.id!, referencePadUuid: reference.pad.physical.id!,
      net: signal.pad.netName!, signalCenterNm: signal.center, referenceCenterNm: reference.center,
      returnSpacingSquaredNm: String(spacingSquared), maximumReturnSpacingNm, segmentId: segment.uuid,
      originalStartNm: segment.startNm, originalEndNm: segment.endNm, cutNm: cut,
      maximumLengthNm, removedLengthSquaredNm: String(removedLengthSquaredNm), engineeringBasis: proposal.engineeringBasis };
  });
  return { launches, segments: input.segments.map(s => replacements.get(s.uuid) ?? s),
    scope: "Hypothetical terminal-centre trimming only; the omitted launch and its electrical return remain unqualified.",
    acceptanceChanged: false as const, referenceTerminalConnectivity: "not_assessed" as const };
}

import type { PcbPlaneDesignContract } from "./pcb-design-plane-contract.js";
type PcbDifferentialPairRequirement = NonNullable<PcbPlaneDesignContract["interfaceRequirements"]>["interfaces"][number];
import { routeMmToNativeNm, routeSourceMmToNativeNm } from "./fresh-route-native-units.js";

export const channelMemberNets = (pair: PcbDifferentialPairRequirement): string[] => [pair.nets.positive, pair.nets.negative,
  ...(pair.channel ? [pair.channel.launchNets.positive, pair.channel.launchNets.negative] : []),
  ...(pair.channel?.feedThrough ? [pair.channel.feedThrough.inputNets.positive, pair.channel.feedThrough.inputNets.negative] : [])];
export function channelForNet(contract: PcbPlaneDesignContract, net: string): PcbDifferentialPairRequirement | undefined {
  return contract.interfaceRequirements?.interfaces.find(pair => pair.channel && channelMemberNets(pair).includes(net));
}
/** Draft authorization is only a union of declared intervals, never an escape proof. */
export function channelTrackWidthAllowed(contract: PcbPlaneDesignContract, net: string, widthMm: number): boolean {
  const pair = channelForNet(contract, net);
  if (!pair?.channel) return false;
  const width = routeSourceMmToNativeNm(widthMm);
  const netPoints = contract.nets.find(item => item.name === net)!.endpoints;
  return width >= 200_000 && [pair.geometry.traceWidthMm, ...pair.channel.escapes.filter(escape => netPoints.some(point =>
    point.reference === escape.terminal.reference && point.pin === escape.terminal.pin)).map(escape => escape.traceWidthMm)]
    .some(interval => width >= routeSourceMmToNativeNm(interval.minimumMm) && width <= routeSourceMmToNativeNm(interval.maximumMm));
}
/** Materialize exactly once before native validation, write and readback.
 * Ordinary nets retain their existing class floor. Channel exceptions remain
 * bounded by explicit intervals and require final routed-escape proof. */
export function materializeChannelTrackWidth(contract: PcbPlaneDesignContract | undefined, net: string, classWidthMm: number, requestedWidthMm?: number): number {
  const widthNm = routeMmToNativeNm(requestedWidthMm ?? classWidthMm);
  if (requestedWidthMm === undefined) return widthNm;
  const member = contract?.nets.find(member => member.name === net);
  const netClass = contract?.netClasses.find(netClass => netClass.id === member?.netClassId);
  if (contract === undefined || netClass === undefined || netClass.traceWidthMm !== classWidthMm)
    throw new Error("Explicit track width requires the exact bound plane net and class width.");
  if (channelForNet(contract, net)) {
    if (!channelTrackWidthAllowed(contract, net, widthNm / 1e6))
      throw new Error("Explicit channel width requires its declared body or terminal-escape interval.");
  } else if (requestedWidthMm < netClass.traceWidthMm || widthNm < routeSourceMmToNativeNm(netClass.traceWidthMm)) {
    throw new Error("Explicit track width is below its existing net-class floor.");
  }
  return widthNm;
}

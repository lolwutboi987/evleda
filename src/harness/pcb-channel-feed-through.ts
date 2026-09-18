import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { PcbPlaneDesignContract } from "./pcb-design-plane-contract.js";
import type { PcbLibraryBinding, PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";
import { assertPcbLibrarySourcesCurrent, isPcbLibraryRecordAuthorized } from "./pcb-library-source-binding.js";
import { selectFreshSymbolTerminalGeometryPins } from "./fresh-kicad-parser.js";
import type { FreshContractPadPosition } from "./kicad-tools.js";
import { routeSourceMmToNativeNm } from "./fresh-route-native-units.js";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** Pin/source consistency only. The explicitly bound manufacturer citation asserts the internal transfer; names alone never establish it. */
export function assertPcbChannelFeedThroughSources(contract: PcbPlaneDesignContract, library: PcbLibraryBinding, resolver: PcbReadOnlyLibraryResolver): void {
  const channels = contract.interfaceRequirements?.interfaces.filter(pair => pair.channel?.feedThrough !== undefined) ?? [];
  if (channels.length === 0) return;
  if (!same(library.contractIdentity, contract.identity)) throw new Error("Feed-through source binding differs from the closed contract.");
  assertPcbLibrarySourcesCurrent(library, resolver);
  for (const pair of channels) {
    const transfer = pair.channel!.feedThrough!, protection = pair.channel!.protection[0]!;
    const record = library.symbols.find(value => value.reference === transfer.componentReference);
    const selected = library.sourceSelection?.records.find(value => value.kind === "symbol" && value.libraryId === record?.libraryId);
    const inspection = record === undefined ? null : resolver.inspectSymbol?.(record.libraryId);
    const geometry = record === undefined ? null : resolver.inspectSymbolTerminalGeometry?.(record.libraryId);
    if (record === undefined || selected === undefined || inspection == null || geometry == null || record.componentKind === "connector") throw new Error("Feed-through requires the exact source-pinned six-pin protection symbol and full host inspection.");
    const { identity, ...inspectionPayload } = inspection, { reference: _reference, ...resolved } = record;
    if (!same(identity, canonicalIdentity(inspectionPayload, inspection.schemaVersion)) || inspection.libraryId !== record.libraryId
      || !same(inspection.sourceIdentity, selected.sourceIdentity) || !same(inspection.identity, selected.inspectionIdentity)
      || !same(inspection.resolverRecord, resolved) || !isPcbLibraryRecordAuthorized(resolver, "symbol", inspection.resolverRecord, library.sourceSelection)
      || geometry.libraryId !== record.libraryId || !same(geometry.sourceIdentity, inspection.sourceIdentity)
      || geometry.representations.some(value => value.unit > 1 || value.bodyStyle > 1)) throw new Error("Feed-through selected symbol differs from its approved complete source inspection.");
    const pins = selectFreshSymbolTerminalGeometryPins(geometry, 1, 1);
    const declared = [transfer.positive.inputPin, transfer.positive.outputPin, transfer.negative.inputPin, transfer.negative.outputPin, protection.ground.pin, protection.supply.pin];
    if (pins.length !== 6 || inspection.pins.length !== 6 || new Set(declared).size !== 6 || pins.some(pin => {
      const full = inspection.pins.find(value => value.number === pin.number);
      return !declared.includes(pin.number) || full === undefined || full.name !== (["", "~"].includes(pin.name) ? null : pin.name)
        || full.electricalType !== pin.electricalType || !full.unitNumbers.includes(1);
    })) throw new Error("Feed-through must preserve the complete inspected four IO pins plus ground and supply.");
    const names: string[] = [];
    for (const polarity of ["positive", "negative"] as const) {
      const leg = transfer[polarity], input = pins.find(pin => pin.number === leg.inputPin)!, output = pins.find(pin => pin.number === leg.outputPin)!;
      if (input.electricalType !== "passive" || output.electricalType !== "passive" || !/^I\/?O[0-9]+$/u.test(input.name) || input.name !== output.name) throw new Error("Each asserted feed-through pair requires matching source-inspected passive IO names and types.");
      names.push(input.name);
    }
    const ground = pins.find(pin => pin.number === protection.ground.pin)!, supply = pins.find(pin => pin.number === protection.supply.pin)!;
    if (names[0] === names[1] || ground.electricalType !== "power_in" || !/^(?:GND|PGND|VSS)$/u.test(ground.name)
      || supply.electricalType !== "power_in" || !/^(?:VBUS|VCC|VDD)$/u.test(supply.name)) throw new Error("Feed-through channels and inspected protection ground/supply roles must remain distinct.");
  }
  // A source change during the added inspection must not mint a ready bundle.
  assertPcbLibrarySourcesCurrent(library, resolver);
}

/** Only host source/library/native-matched PAD inputs can distinguish this explicit output fork from a serial trace corner. */
export function isPcbChannelFeedThroughOutputFork(contract: PcbPlaneDesignContract, net: string, point: { xMm: number; yMm: number }, layer: string,
  sourceNativeMatchedPads: readonly FreshContractPadPosition[]): boolean {
  const declarations = contract.interfaceRequirements?.interfaces.flatMap(pair => pair.channel?.feedThrough === undefined ? [] : (["positive", "negative"] as const)
    .filter(polarity => pair.nets[polarity] === net).map(polarity => ({ reference: pair.channel!.feedThrough!.componentReference, pin: pair.channel!.feedThrough![polarity].outputPin }))) ?? [];
  if (declarations.length !== 1) return false;
  const selected = declarations[0]!, matches = sourceNativeMatchedPads.filter(pad => pad.reference === selected.reference && pad.pad === selected.pin);
  if (matches.length !== 1) return false;
  const pad = matches[0]!, physical = pad.physical;
  return pad.net === net && pad.layers.includes(layer) && physical !== undefined && physical.padType === "smd" && physical.drill === null
    && ["rect", "roundrect", "circle", "oval"].includes(physical.shape) && physical.id.length > 0 && physical.footprintId.length > 0
    && [physical.sizeMm.x, physical.sizeMm.y].every(value => Number.isFinite(value) && value > 0)
    && routeSourceMmToNativeNm(pad.xMm) === routeSourceMmToNativeNm(point.xMm) && routeSourceMmToNativeNm(pad.yMm) === routeSourceMmToNativeNm(point.yMm);
}

export const PCB_FEED_THROUGH_EXECUTION_GUIDANCE = "An explicit channel.feedThrough declares one manufacturer-cited two-line protection component transfer between six distinct native copper nets. Each transfer maps exact inspected passive IO input/output pins; matching names are consistency evidence, never inferred conduction authority. Keep all signal pins and protection ground/supply. Prove each launch, resistor-to-protection input and protection-output-to-contact copper net independently. Pair geometry length, skew and uncoupled budgets cover the combined input and output PCB sections; channel budgets cover all three PCB sections. Package paths are component transfers, never PCB segments: their resistance, inductance, electrical delay/skew and whole-channel behavior remain not assessed, not zero.";

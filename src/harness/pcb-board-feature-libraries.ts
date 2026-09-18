import { canonicalJson } from "../core/canonical.js";
import type { PcbLibraryFootprintBinding, PcbReadOnlyLibraryResolver } from "./pcb-design-compiler.js";
import { capturePcbLibrarySourceSelection, assertPcbLibrarySourceSelectionStable, isPcbLibraryRecordAuthorized, type PcbLibrarySourceSelection } from "./pcb-library-source-binding.js";
import { assertPcbBoardFeatureSourceBytes, isSupportedMechanicalFootprintPads, type PcbBoardFeature, type PcbBoardFeatureLibrarySource } from "./pcb-board-features.js";
import { parseFreshPcbSourceDocument } from "./fresh-kicad-parser.js";

/** Extend the existing complete physical library binding, without creating schematic symbols or terminals. */
export function resolvePcbBoardFeatureLibraries(features: readonly PcbBoardFeature[] | undefined, libraries: {
  readonly symbols: readonly { readonly libraryId: string }[]; readonly footprints: readonly PcbLibraryFootprintBinding[];
  readonly sourceSelection?: PcbLibrarySourceSelection;
}, resolver: PcbReadOnlyLibraryResolver) {
  if (features === undefined) return { footprints: libraries.footprints,
    ...(libraries.sourceSelection === undefined ? {} : { sourceSelection: libraries.sourceSelection }) };
  if (resolver.inspectFootprint === undefined || resolver.readFootprintSource === undefined) throw new Error("Board features require complete approved footprint inspection and exact source bytes.");
  const selected = { symbolIds: [...new Set(libraries.symbols.map(record => record.libraryId))],
    footprintIds: [...new Set([...libraries.footprints.map(record => record.libraryId), ...features.map(feature => feature.footprintLibId)])] };
  const sourceSelection = capturePcbLibrarySourceSelection(resolver, selected);
  if (sourceSelection === undefined) throw new Error("Board features require current source-pinned approved libraries.");
  if (libraries.sourceSelection !== undefined && libraries.sourceSelection.records.some(record =>
    !sourceSelection.records.some(current => canonicalJson(record) === canonicalJson(current)))) throw new Error("Electrical library sources changed while binding board features.");
  const boardFeatureLibrarySources: PcbBoardFeatureLibrarySource[] = [];
  const footprints = [...libraries.footprints];
  for (const feature of features) {
    const inspected = resolver.inspectFootprint(feature.footprintLibId), bytes = resolver.readFootprintSource(feature.footprintLibId);
    if (inspected === null || bytes === null || inspected.side !== "front" || inspected.libraryId !== feature.footprintLibId
        || inspected.pads.length !== 0 || inspected.resolverRecord.pads.length !== 0 || inspected.resolverRecord.packageKind !== "generic"
        || !isSupportedMechanicalFootprintPads(inspected.physicalPads)
        || canonicalJson(inspected.sourceIdentity) !== canonicalJson(bytes.sourceIdentity)
        || !isPcbLibraryRecordAuthorized(resolver, "footprint", inspected.resolverRecord, sourceSelection)) throw new Error(`Board feature ${feature.reference} lacks a source-bound mechanical-only footprint.`);
    const source = { libraryId: feature.footprintLibId, ...bytes };
    assertPcbBoardFeatureSourceBytes(source);
    const pad = parseFreshPcbSourceDocument(`(kicad_pcb ${bytes.source})`).children[0]!.children.find(node => node.name === "pad")!;
    const drill = pad.children.find(node => node.name === "drill")!;
    if (Number(drill.values[0]!.value) !== feature.boreDiameterMm) throw new Error(`Board feature ${feature.reference} bore differs from its approved footprint.`);
    const pin = sourceSelection.records.find(record => record.kind === "footprint" && record.libraryId === feature.footprintLibId);
    if (pin === undefined || canonicalJson(pin.sourceIdentity) !== canonicalJson(bytes.sourceIdentity)
        || canonicalJson(pin.inspectionIdentity) !== canonicalJson(inspected.identity)) throw new Error("Board feature source or inspection differs from selected source authority.");
    footprints.push({ reference: feature.reference, libraryId: feature.footprintLibId, source: inspected.resolverRecord.source, packageKind: "generic", pads: [] });
    if (!boardFeatureLibrarySources.some(record => record.libraryId === source.libraryId)) boardFeatureLibrarySources.push(source);
  }
  assertPcbLibrarySourceSelectionStable(sourceSelection, capturePcbLibrarySourceSelection(resolver, selected));
  return { footprints: footprints.sort((a, b) => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0), sourceSelection,
    boardFeatureLibrarySources: boardFeatureLibrarySources.sort((a, b) => a.libraryId < b.libraryId ? -1 : a.libraryId > b.libraryId ? 1 : 0) };
}

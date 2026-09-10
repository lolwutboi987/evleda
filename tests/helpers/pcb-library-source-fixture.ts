import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createPcbLibrarySourceSelection, type PcbLibrarySourceSelectionRequest } from "../../src/harness/pcb-library-source-binding.js";

/** Mutable raw-source fixture whose normalized resolver results deliberately stay unchanged. */
export function sourceAwareLibraryFixture<T extends object>(base: T) {
  const revision = { symbol: 0, footprint: 0 };
  const policyIdentity = canonicalIdentity({ fixture: "host-library-policy" }, "evleda.test-library-policy.v1");
  const captureSourceSelection = (request: PcbLibrarySourceSelectionRequest) => createPcbLibrarySourceSelection({
    policyIdentity,
    records: (["symbol", "footprint"] as const).flatMap(kind =>
      (kind === "symbol" ? request.symbolIds : request.footprintIds).map(libraryId => ({
        kind, libraryId, sourceIdentity: contentIdentity(`${kind}:${libraryId}:${revision[kind]}`),
        inspectionIdentity: canonicalIdentity({ kind, libraryId }, kind === "symbol"
          ? "evleda.kicad-stock-symbol-inspection.v1" : "evleda.kicad-stock-footprint-inspection.v2"),
      }))),
  }, request);
  return { resolver: { ...base, captureSourceSelection },
    changeSource: (kind: "symbol" | "footprint") => { revision[kind] += 1; } };
}

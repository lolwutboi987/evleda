import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { readKicadToolboxDesignProfile } from "../flux/production-composition.js";
import { createKiCad10StockLibraryResolver } from "../harness/kicad-library-resolver.js";
import { createKiCad10StockCatalog } from "../harness/kicad-stock-catalog.js";
import { KiCadApprovedPackageResolver } from "../harness/kicad-approved-package.js";
import { createDeepRuleResourceProfile, loadDeepRuleResource } from "../harness/deep-rule-catalog.js";
import type { KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";

/** Reuse the existing profile-approved stock libraries and complete rule corpus. */
export async function loadKicadToolboxFreshProfile(input: KicadMcpPinnedFileInput) {
  const profile = await readKicadToolboxDesignProfile(input);
  const catalog = "mode" in profile.libraries ? createKiCad10StockCatalog(profile.libraries) : undefined;
  const stockResolver = catalog ?? (() => {
    if ("mode" in profile.libraries) throw new Error("Stock catalog was not initialized.");
    const exact = createKiCad10StockLibraryResolver(profile.libraries);
    for (const id of profile.libraries.exactSymbolIds) {
      if (exact.resolveSymbol(id) === null) throw new Error(`Approved stock symbol is unavailable: ${id}`);
    }
    for (const id of profile.libraries.exactFootprintIds) {
      if (exact.resolveFootprint(id) === null) throw new Error(`Approved stock footprint is unavailable: ${id}`);
    }
    return exact;
  })();
  const libraryResolver = profile.libraries.approvedPackage === undefined ? stockResolver
    : new KiCadApprovedPackageResolver(profile.libraries.approvedPackage, stockResolver, profile.libraries);
  const resource = loadDeepRuleResource(createDeepRuleResourceProfile(profile.deepRules.resourceRoot, profile.deepRules.resourceIdentity));
  if (canonicalJson(canonicalIdentity(resource.catalog, "evleda.deep-rule-catalog.v1")) !== canonicalJson(profile.deepRules.catalogIdentity)) {
    throw new Error("Toolbox design guidance differs from the approved catalog identity.");
  }
  return Object.freeze({ dependencies: Object.freeze({ libraryResolver, deepRuleCatalog: resource.catalog }),
    deepRuleSelectionOptions: profile.deepRules.selection,
    protectedRoots: Object.freeze([profile.libraries.symbolRoot, profile.libraries.footprintRoot, profile.deepRules.resourceRoot,
      ...(profile.libraries.approvedPackage === undefined ? [] : [profile.libraries.approvedPackage.root])]),
    libraryEnvironment: Object.freeze({ KICAD10_SYMBOL_DIR: profile.libraries.symbolRoot, KICAD10_FOOTPRINT_DIR: profile.libraries.footprintRoot }),
    profileIdentity: profile.contentIdentity,
    ...(libraryResolver instanceof KiCadApprovedPackageResolver ? { describeApprovedPackage: libraryResolver.describeApprovedPackage.bind(libraryResolver) } : {}),
    ...(catalog === undefined ? {} : { searchLibrary: catalog.search.bind(catalog) }) });
}

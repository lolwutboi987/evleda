import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { boardFeature, holeSource } from "./board-feature-fixture.js";
import type { PcbBoardFeature } from "../../src/harness/pcb-board-features.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { createKiCad10StockCatalog } from "../../src/harness/kicad-stock-catalog.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { prepareKicadToolboxPlaneProject, type KicadToolboxPlanePreparationInput } from "../../src/mcp/toolbox-plane-preparation.js";
import { createToolboxWorkspaceStore } from "../../src/mcp/toolbox-workspace-store.js";
import { captureClosedPlaneSchematicSeedSource } from "../../src/mcp/toolbox-schematic-seed.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import { planeDividerDraft } from "./plane-divider-draft.js";

const symbol = (name: string, prefix: string, count: number) => `(symbol "${name}" (property "Reference" "${prefix}" (at 0 0 0)) (property "Value" "${name}" (at 0 0 0))
  (symbol "${name}_1_1" ${Array.from({ length: count }, (_, index) => `(pin passive line (at ${index * 2.54} 0 0) (length 2.54)
    (name "${index + 1}" (effects (font (size 1.27 1.27)))) (number "${index + 1}" (effects (font (size 1.27 1.27)))))`).join(" ")}))`;
const footprint = (name: string, count: number) => `(footprint "${name}" (version 20240108) (layer "F.Cu")
  (fp_rect (start -2 -2) (end 4 2) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
  ${Array.from({ length: count }, (_, index) => `(pad "${index + 1}" smd rect (at ${index * 2} 0) (size 1 1) (layers "F.Cu" "F.Mask"))`).join(" ")})`;

/** Synthetic ready geometry revision; no native or physical qualification. */
export function unwiredPlaneSeedGeometryDraft(widthMm = 21, heightMm = 51) {
  const draft = planeDividerDraft();
  Object.assign(draft.scope.board, { widthMm, heightMm });
  for (const constraint of draft.placementConstraints) Object.assign(constraint.regionMm, { maxXmm: widthMm - 1, maxYmm: heightMm - 1 });
  Object.assign(draft.planes[0]!.boundary, { maxXmm: widthMm - 0.5, maxYmm: heightMm - 0.5 });
  const boardFeatures: PcbBoardFeature[] = [boardFeature(), boardFeature("H2", widthMm - 3, heightMm - 3)];
  return { ...draft, boardFeatures };
}

/** Synthetic filesystem/adapter fixture; production allocation/compilation/seed guards remain real. */
export async function unwiredPlaneSeedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-unwired-seed-"));
  const workspaceRoot = path.join(root, "workspace"), stock = path.join(root, "stock");
  await mkdir(workspaceRoot);
  const definitions = new Map([["Device:R", symbol("R", "R", 2)], ["Connector_Generic:Conn_01x03", symbol("Conn_01x03", "J", 3)]]);
  const put = async (relative: string, source: string) => { const file = path.join(stock, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); return file; };
  const librarySources = new Map<string, { source: string; identity: ReturnType<typeof contentIdentity> }>();
  for (const [id, definition] of definitions) { const source = `(kicad_symbol_lib (version 20231120) ${definition})\n`;
    await put(`symbols/${id.split(":")[0]}.kicad_sym`, source); librarySources.set(id, { source, identity: contentIdentity(source) }); }
  await put("footprints/Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod", footprint("R_0603_1608Metric", 2));
  await put("footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x03_P2.54mm_Vertical.kicad_mod", footprint("PinHeader_1x03_P2.54mm_Vertical", 3));
  await put("footprints/MountingHole.pretty/Hole_D2.1.kicad_mod", holeSource);
  await put("footprints/MountingHole.pretty/Hole_D2.1_Alternate.kicad_mod", holeSource.replace('"Hole_D2.1"', '"Hole_D2.1_Alternate"'));
  const symbolRoot = path.join(stock, "symbols"), footprintRoot = path.join(stock, "footprints");
  const resolver = createKiCad10StockCatalog({ symbolRoot, footprintRoot, stockSymbolNicknames: ["Connector_Generic", "Device"],
    stockFootprintNicknames: ["Connector_PinHeader_2.54mm", "MountingHole", "Resistor_SMD"] });
  const dependencies = { libraryResolver: resolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const profilePath = path.join(root, "native-profile.json"), profileBytes = '{"syntheticNativeProfile":true}\n';
  await writeFile(profilePath, profileBytes);
  const profile = { path: profilePath, contentIdentity: contentIdentity(profileBytes) };
  const store = await createToolboxWorkspaceStore({ workspaceRoot, protectedRoots: [stock, profilePath] });
  const leases: { release(): Promise<void> }[] = [];
  const acquireLease = async (id: string) => { const lease = await store.acquireLease(id); leases.push(lease); return lease; };
  const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(root, "fixture.exe"), version: "10.0.3", commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
    sha256: "a".repeat(64), sizeBytes: 100, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
  const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
    operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
    identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") };
  const createKicadCliAdapter = async () => ({ identity } as KicadCliAdapter);
  const compile = (draft = planeDividerDraft(), originalPrompt = "Synthetic unwired seed test") => {
    const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
    if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
    return createPcbPlaneCompilationBundle({ compilation, originalPrompt }, dependencies);
  };
  const prepare = async (outputDir: string, draft = planeDividerDraft(), options: Partial<KicadToolboxPlanePreparationInput> = {}) => {
    const outcome = await prepareKicadToolboxPlaneProject({ outputDir, name: "seeded", draft, originalPrompt: "Synthetic unwired seed test", dependencies,
      expectedKicadCli, createKicadCliAdapter, ...options });
    if (outcome.status !== "prepared") throw new Error(JSON.stringify(outcome)); return outcome.preparation;
  };
  const source = (bundle: ReturnType<typeof compile>, references = ["R1"], rootUuid = randomUUID()) => {
    const components = bundle.contract.components.filter(component => references.includes(component.reference));
    const libraries = [...new Set(components.map(component => component.symbolLibId))];
    return `(kicad_sch (version 20250316) (generator "seed-fixture") (uuid "${rootUuid}") (paper "A4") (title_block (title "seeded"))
      (lib_symbols ${libraries.map(id => definitions.get(id)!.replace(`(symbol "${id.split(":")[1]}"`, `(symbol "${id}"`)).join("\n")})
      ${components.map(component => `(symbol (lib_id "${component.symbolLibId}") (at 20 20 0) (unit 1) (uuid "${randomUUID()}")
        (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
        ${[["Reference", component.reference], ["Value", component.value], ["Footprint", component.footprintLibId]].map(([name, value]) =>
          `(property "${name}" "${value}" (at 20 18 0) (effects (font (size 1.27 1.27))))`).join("\n")}
        (instances (project "seeded" (path "/${rootUuid}" (reference "${component.reference}") (unit 1)))))`).join("\n")}
      (sheet_instances (path "/" (page "1"))) (embedded_fonts no))\n`;
  };
  const closedSource = async (draft = planeDividerDraft()) => {
    const projectId = randomUUID();
    const allocation = await store.allocate({ projectId, name: "seeded", originalPrompt: "Synthetic unwired seed test", draft, draftIdentity: contentIdentity(canonicalJson(draft)) });
    const lease = await acquireLease(projectId), preparation = await prepare(allocation.outputDir, draft);
    const bytes = source(preparation.bundle); await writeFile(preparation.project.schematicPath, bytes);
    await preparation.project.checkpointAfterReport(preparation.reportPath, "needs_review");
    const receipt = await captureClosedPlaneSchematicSeedSource({ project: preparation.project, bundle: preparation.bundle, dependencies, profile, symbolRoot });
    if (!receipt) throw new Error("Expected eligible test source");
    await lease.release(); return { projectId, allocation, preparation, bytes, receipt };
  };
  return { root, stock, workspaceRoot, profile, store: { ...store, acquireLease }, dependencies, symbolRoot, librarySources, definitions,
    expectedKicadCli, createKicadCliAdapter, compile, prepare, source, closedSource,
    cleanup: async () => { for (const lease of leases) await lease.release();
      if (!path.basename(root).startsWith("evleda-unwired-seed-") || path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error("Unsafe test cleanup");
      await rm(root, { recursive: true, force: true }); } };
}

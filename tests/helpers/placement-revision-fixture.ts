import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { seedFreshBoardFeatures } from "../../src/harness/fresh-board-features.js";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { unwiredPlaneSeedFixture, unwiredPlaneSeedGeometryDraft } from "./unwired-plane-seed.js";
import { fourLayerPlaneDraft } from "./four-layer-plane-bundle.js";
export async function placementRevisionFixture(options: { viaBudgetHeadroom?: boolean; regionalPlane?: boolean; terminalLaunch?: boolean } = {}) {
  const f = await unwiredPlaneSeedFixture({ throughHoleHeader: options.terminalLaunch === true });
  const base = unwiredPlaneSeedGeometryDraft(30, 20);
  // Both inputs pass the real compiler; this fixture's existing helper signature
  // uses the divider shape for historical callers.
  const draft = options.regionalPlane ? { ...fourLayerPlaneDraft(), boardFeatures: base.boardFeatures } as typeof base : base;
  if (options.viaBudgetHeadroom) {
    draft.routingConstraints.viaPolicy.maxTotal = 4;
    for (const netClass of draft.netClasses) netClass.allowedLayers = ["F.Cu", "B.Cu"];
  }
  const sourceAllocation = await f.store.allocate({ projectId: randomUUID(), name: "seeded", draft,
    originalPrompt: "Synthetic unwired seed test", draftIdentity: contentIdentity(canonicalJson(draft)) });
  const preparation = await f.prepare(sourceAllocation.outputDir, draft);
  const source = preparation.bundle, revised = structuredClone(draft);
  if (!options.regionalPlane) revised.placementConstraints[1]!.allowedRotationsDeg = [0, 90, 180, 270];
  revised.placementConstraints[1]!.regionMm.minXmm += 0.01;
  const target = f.compile(revised, "Explicit revised placement intent");
  const electrical = source.contract.components.map((c, i) => `(footprint "${c.footprintLibId}" (layer "F.Cu") (at ${5 + i * 5} 10)
    (uuid "${randomUUID()}") (property "Reference" "${c.reference}") (property "Value" "${c.value}")
    ${c.pins.map((p, j) => `(pad "${p.pin}" ${options.terminalLaunch && c.reference === "J1" ? `thru_hole circle (at ${j * 2} 0) (size 1 1) (drill 0.4) (layers "*.Cu" "*.Mask")` : `smd rect (at ${j * 2} 0) (size 1 1) (layers "F.Cu" "F.Mask")`}
      (net "${source.contract.nets.find(n => n.endpoints.some(e => e.reference === c.reference && e.pin === p.pin))!.name}") (uuid "${randomUUID()}"))`).join("\n")})`).join("\n");
  const rules = createFreshPlaneRules(source);
  const zone = source.contract.planes.map(plane => `(zone (net "GND") (layer "${plane.layer}") (uuid "${randomUUID()}") (name "${rules.zones.find(r=>r.planeId===plane.id)!.zoneName}")
    (connect_pads (clearance 0.25)) (min_thickness 0.5) (fill yes (thermal_gap 0.25) (thermal_bridge_width 0.5))
    (polygon (pts (xy 0.5 0.5) (xy 29.5 0.5) (xy 29.5 19.5) (xy 0.5 19.5)))
    (filled_polygon (layer "${plane.layer}") (pts (xy 1 1) (xy 29 1) (xy 29 19) (xy 1 19))))`).join("\n");
  const empty = await readFile(preparation.project.pcbPath, "utf8");
  const featureSource = seedFreshBoardFeatures(source, empty);
  const launchRoute = options.terminalLaunch ? [[5,10,6,9],[6,9,9,9],[9,9,10,10]].map(([x1,y1,x2,y2]) =>
    `(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width 0.5) (layer "F.Cu") (net "VIN") (uuid "${randomUUID()}"))`).join("\n") : "";
  const pcb = featureSource.slice(0, featureSource.lastIndexOf(")")) + electrical + zone + launchRoute
    + `(segment (start 6 11) (end 8 13) (width 0.3) (layer "F.Cu") (net "GND") (uuid "${randomUUID()}"))
    (via (at 8 13) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${randomUUID()}")))`;
  const projectSettings = JSON.parse(await readFile(path.join(preparation.project.projectPath, "seeded.kicad_pro"), "utf8"));
  projectSettings.net_settings.netclass_patterns = projectSettings.net_settings.netclass_patterns.map((p: { pattern: string; netclass: string }) =>
    ({ netclass: p.netclass, pattern: p.pattern }));
  const pro = JSON.stringify(projectSettings, null, 2) + "\n";
  const sch = f.source(source, source.contract.components.map(c => c.reference));
  return { f, preparation, sourceAllocation, draft, revised, source, target, zone, input: { name: "seeded", sourceBundle: source, targetBundle: target,
    sources: { pcb, sch, pro, dru: rules.source } } };
}

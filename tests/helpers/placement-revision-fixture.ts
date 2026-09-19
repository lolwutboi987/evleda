import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { seedFreshBoardFeatures } from "../../src/harness/fresh-board-features.js";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { unwiredPlaneSeedFixture, unwiredPlaneSeedGeometryDraft } from "./unwired-plane-seed.js";
export async function placementRevisionFixture() {
  const f = await unwiredPlaneSeedFixture();
  const draft = unwiredPlaneSeedGeometryDraft(30, 20);
  const sourceAllocation = await f.store.allocate({ projectId: randomUUID(), name: "seeded", draft,
    originalPrompt: "Synthetic unwired seed test", draftIdentity: contentIdentity(canonicalJson(draft)) });
  const preparation = await f.prepare(sourceAllocation.outputDir, draft);
  const source = preparation.bundle, revised = structuredClone(draft);
  revised.placementConstraints[1]!.allowedRotationsDeg = [0, 90, 180, 270];
  revised.placementConstraints[1]!.regionMm.minXmm += 0.01;
  const target = f.compile(revised, "Explicit revised placement intent");
  const electrical = source.contract.components.map((c, i) => `(footprint "${c.footprintLibId}" (layer "F.Cu") (at ${5 + i * 5} 10)
    (uuid "${randomUUID()}") (property "Reference" "${c.reference}") (property "Value" "${c.value}")
    ${c.pins.map((p, j) => `(pad "${p.pin}" smd rect (at ${j * 2} 0) (size 1 1) (layers "F.Cu" "F.Mask")
      (net "${source.contract.nets.find(n => n.endpoints.some(e => e.reference === c.reference && e.pin === p.pin))!.name}") (uuid "${randomUUID()}"))`).join("\n")})`).join("\n");
  const rules = createFreshPlaneRules(source);
  const zone = `(zone (net "GND") (layer "B.Cu") (uuid "${randomUUID()}") (name "${rules.zones[0]!.zoneName}")
    (connect_pads (clearance 0.25)) (min_thickness 0.5) (fill yes (thermal_gap 0.25) (thermal_bridge_width 0.5))
    (polygon (pts (xy 0.5 0.5) (xy 29.5 0.5) (xy 29.5 19.5) (xy 0.5 19.5)))
    (filled_polygon (layer "B.Cu") (pts (xy 1 1) (xy 29 1) (xy 29 19) (xy 1 19))))`;
  const empty = await readFile(preparation.project.pcbPath, "utf8");
  const featureSource = seedFreshBoardFeatures(source, empty);
  const pcb = featureSource.slice(0, featureSource.lastIndexOf(")")) + electrical + zone
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

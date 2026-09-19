import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { planPlanePlacementRevisionSources, assertPlanePlacementRevisionScope } from "../../src/harness/fresh-plane-placement-revision.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { seedFreshBoardFeatures, verifyFreshBoardFeatures } from "../../src/harness/fresh-board-features.js";
import { unwiredPlaneSeedFixture, unwiredPlaneSeedGeometryDraft } from "../helpers/unwired-plane-seed.js";

const fixtures: Awaited<ReturnType<typeof unwiredPlaneSeedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
async function fixture() {
  const f = await unwiredPlaneSeedFixture(); fixtures.push(f);
  const draft = unwiredPlaneSeedGeometryDraft(30, 20);
  const preparation = await f.prepare(path.join(f.root, "materialized-source"), draft);
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
  const empty = `(kicad_pcb (version 20260206) (generator "pcbnew"))`;
  const featureSource = seedFreshBoardFeatures(source, empty);
  const pcb = featureSource.slice(0, -1) + electrical + zone
    + `(segment (start 6 11) (end 8 13) (width 0.3) (layer "F.Cu") (net "GND") (uuid "${randomUUID()}"))
    (via (at 8 13) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${randomUUID()}")))`;
  const pro = await readFile(path.join(preparation.project.projectPath, "seeded.kicad_pro"), "utf8");
  const sch = f.source(source, source.contract.components.map(c => c.reference));
  return { f, draft, revised, source, target, zone, input: { name: "seeded", sourceBundle: source, targetBundle: target,
    sources: { pcb, sch, pro, dru: rules.source } } };
}

describe("placement revision source proposal", () => {
  it("changes only owned namespaces while preserving circuit source and existing routing", async () => {
    const { input, source, target } = await fixture();
    const settings = JSON.parse(input.sources.pro);
    settings.user_note = `Retain literal EVLEDA_${source.identity.digest.slice(0, 12)}_C01`;
    input.sources.pro = JSON.stringify(settings);
    const before = structuredClone(input.sources), result = planPlanePlacementRevisionSources(input);
    expect(input.sources).toEqual(before);
    expect(result.sources.sch).toBe(before.sch);
    expect(parseFreshPcbSource(result.sources.pcb).segments).toEqual(parseFreshPcbSource(before.pcb).segments);
    expect(parseFreshPcbSource(result.sources.pcb).vias).toEqual(parseFreshPcbSource(before.pcb).vias);
    expect(result.sources.pcb).toContain(createFreshPlaneRules(target).zones[0]!.zoneName);
    expect(result.sources.pcb).not.toContain(createFreshPlaneRules(source).zones[0]!.zoneName);
    expect(() => verifyFreshBoardFeatures(target, result.sources.pcb)).not.toThrow();
    expect(() => verifyFreshBoardFeatures(source, result.sources.pcb)).toThrow();
    expect(result.sources.dru).toBe(createFreshPlaneRules(target).source);
    const afterSettings = JSON.parse(result.sources.pro);
    expect(afterSettings.user_note).toBe(settings.user_note);
    expect(afterSettings.board).toEqual(settings.board);
    expect(afterSettings.erc).toEqual(settings.erc);
    expect(afterSettings.net_settings.classes.find((c: { name: string }) => c.name === "Default"))
      .toEqual(settings.net_settings.classes.find((c: { name: string }) => c.name === "Default"));
    expect(result.receipt).toMatchObject({ schematicBytesPreserved: true, routingGeometryPreserved: true,
      functionalFootprintsPreserved: true, freshnessTransferred: false, sourceLifecycleQualified: false,
      nativeAuthoringPerformed: false, acceptanceEvaluated: false });
    expect(result.receipt.featureUuidMappings.length).toBeGreaterThan(2);
    expect(result.receipt.zoneNameMappings).toHaveLength(1);
    const orderedIds = parseFreshPcbSource(result.sources.pcb).footprints.map(f => f.id);
    expect(orderedIds).toEqual([...orderedIds].sort());
    const beforeByReference = new Map(parseFreshPcbSource(before.pcb).footprints.map(f => [f.reference, f]));
    for (const footprint of parseFreshPcbSource(result.sources.pcb).footprints.filter(f => !f.reference.startsWith("H"))) {
      expect(footprint).toEqual(beforeByReference.get(footprint.reference));
    }
  });

  it("rejects unauthenticated bundles and no-op intent", async () => {
    const { source, target } = await fixture();
    expect(() => assertPlanePlacementRevisionScope(structuredClone(source), target)).toThrow(/authenticated/);
    expect(() => assertPlanePlacementRevisionScope(source, structuredClone(target))).toThrow(/authenticated/);
    expect(() => assertPlanePlacementRevisionScope(source, source)).toThrow(/must change/);
  });

  it.each(["value", "routing", "board", "plane", "feature"])("rejects %s changes outside placement intent", async change => {
    const { f, source, revised } = await fixture();
    if (change === "value") revised.components[1]!.value += " revised";
    if (change === "routing") {
      const route = revised.routingConstraints.nets.find(r => "routeLength" in r);
      if (route === undefined || !("routeLength" in route) || route.routeLength === undefined) throw new Error("Missing trace fixture");
      Object.assign(route.routeLength, { mode: "bounded", maximumMm: 50 });
    }
    if (change === "board") revised.scope.board.widthMm += 1;
    if (change === "plane") revised.planes[0]!.clearanceMm += 0.01;
    if (change === "feature") revised.boardFeatures[0]!.pose.xMm += 0.1;
    expect(() => assertPlanePlacementRevisionScope(source, f.compile(revised))).toThrow(/only component placement/);
  });

  it.each(["rules", "zone-name", "zone-net", "zone-duplicate", "feature-uuid", "external-feature-reference", "project-feature-reference", "schematic-feature-reference", "missing-component", "back-footprint"])
  ("rejects altered or unsupported source ownership: %s", async change => {
    const { input, source, zone } = await fixture();
    const featureId = parseFreshPcbSource(input.sources.pcb).footprints.find(f => f.reference === "H1")!.id!;
    if (change === "rules") input.sources.dru += "\n";
    if (change === "zone-name") input.sources.pcb = input.sources.pcb.replace(createFreshPlaneRules(source).zones[0]!.zoneName, "foreign-zone");
    if (change === "zone-net") input.sources.pcb = input.sources.pcb.replace('(zone (net "GND")', '(zone (net "VIN")');
    if (change === "zone-duplicate") input.sources.pcb = input.sources.pcb.slice(0, -1) + zone.replace(/\(uuid "[^"]+"\)/u, `(uuid "${randomUUID()}")`) + ")";
    if (change === "feature-uuid") input.sources.pcb = input.sources.pcb.replace(featureId, randomUUID());
    if (change === "external-feature-reference") input.sources.pcb = input.sources.pcb.slice(0, -1) + `(property "extra" "${featureId}"))`;
    if (change === "project-feature-reference") input.sources.pro = JSON.stringify({ ...JSON.parse(input.sources.pro), user_feature_link: featureId });
    if (change === "schematic-feature-reference") input.sources.sch += `\n; ${featureId}\n`;
    if (change === "missing-component") input.sources.pcb = input.sources.pcb.replace('(property "Reference" "R1")', '(property "Reference" "R3")');
    if (change === "back-footprint") input.sources.pcb = input.sources.pcb.replace('(layer "F.Cu")', '(layer "B.Cu")');
    expect(() => planPlanePlacementRevisionSources(input)).toThrow();
  });

  it.each(["class-value", "missing-class", "foreign-class", "pattern", "derived", "duplicate-json", "filename"])
  ("rejects project settings ambiguity: %s", async change => {
    const { input } = await fixture(), pro = JSON.parse(input.sources.pro);
    if (change === "class-value") pro.net_settings.classes[1].clearance += 0.01;
    if (change === "missing-class") pro.net_settings.classes.splice(1, 1);
    if (change === "foreign-class") pro.net_settings.classes.push({ ...pro.net_settings.classes[1], name: "EVLEDA_aaaaaaaaaaaa_C01" });
    if (change === "pattern") pro.net_settings.netclass_patterns[0].pattern = "*";
    if (change === "derived") pro.net_settings.netclass_assignments = { VIN: "Default" };
    if (change === "filename") pro.board.file = "elsewhere.kicad_pcb";
    input.sources.pro = JSON.stringify(pro);
    if (change === "duplicate-json") input.sources.pro = input.sources.pro.replace('"board":', '"board":{},"board":');
    const messages: Record<string, RegExp> = { "class-value": /owned class settings/, "missing-class": /omits an owned class/,
      "foreign-class": /foreign or conflicting/, pattern: /patterns/, derived: /label assignments/, "duplicate-json": /duplicate/iu,
      filename: /same local board/ };
    expect(() => planPlanePlacementRevisionSources(input)).toThrow(messages[change]);
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const outputDir = await mkdtemp(path.join(tmpdir(), "evleda-fresh-layers-")); roots.push(outputDir);
  const { bundle, reference } = createGenericDividerBundleFixture();
  const options = { outputDir, name: "layers", workflowKind: "generic" as const, compilationBundle: bundle, compilationBundleRef: reference };
  return { options, project: await prepareFreshProject({ ...options, resume: false }) };
}
describe("new fresh project presentation layers", () => {
  it("uses the current pinned format and exact front presentation layer IDs", async () => {
    const { project } = await fixture(); const source = await readFile(project.pcbPath, "utf8");
    expect(source).toContain("(version 20260206)");
    expect(source).toContain('(0 "F.Cu" signal)'); expect(source).toContain('(2 "B.Cu" signal)');
    expect(source).toContain('(5 "F.SilkS" user)'); expect(source).toContain('(25 "Edge.Cuts" user)');
    expect(source).toContain('(35 "F.Fab" user)');
    for (const [ordinal, name] of [[1, "F.Mask"], [3, "B.Mask"], [7, "B.SilkS"], [13, "F.Paste"], [15, "B.Paste"], [33, "B.Fab"]] as const) {
      expect(source).toContain(`(${ordinal} "${name}" user)`);
    }
    expect([...source.matchAll(/\(\d+ "([^"]+\.Cu)" signal\)/gu)].map(match => match[1])).toEqual(["F.Cu", "B.Cu"]);
    const parsed = parseFreshPcbSource(source);
    expect(parsed.footprints).toHaveLength(0); expect(parsed.segments).toHaveLength(0); expect(parsed.viaCount).toBe(0);
    const marker = JSON.parse(await readFile(project.markerPath, "utf8"));
    expect(marker.files.pcb.sha256).toBe(contentIdentity(source).digest);
  });
  it("resumes a historical marker/checkpoint without upgrading its layer table", async () => {
    const { project, options } = await fixture();
    // Synthetic historical fixture only: reproduce the previous emitted PCB
    // and its matching marker before minting the test's resume capability.
    const historical = '(kicad_pcb\n  (version 20250316)\n  (generator "KiCad Studio Fixture Corpus")\n  (general)\n  (paper "A4")\n  (layers\n    (0 "F.Cu" signal)\n    (31 "B.Cu" signal)\n    (44 "Edge.Cuts" user)\n  )\n)\n';
    await writeFile(project.pcbPath, historical);
    const marker = JSON.parse(await readFile(project.markerPath, "utf8")); marker.files.pcb.sha256 = contentIdentity(historical).digest;
    await writeFile(project.markerPath, JSON.stringify(marker, null, 2));
    const historicalProject = await prepareFreshProject({ ...options, resume: true });
    const report = path.join(options.outputDir, "pcb-agent-report.json"); await writeFile(report, '{"status":"needs_review"}');
    await historicalProject.checkpointAfterReport(report, "needs_review");
    const checkpointBefore = await readFile(historicalProject.checkpointPath);
    await prepareFreshProject({ ...options, resume: true });
    expect(await readFile(project.pcbPath, "utf8")).toBe(historical);
    expect(await readFile(historicalProject.checkpointPath)).toEqual(checkpointBefore);
  });
});

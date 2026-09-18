import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import {
  applyFreshSchematicStrokeStyle, assertFreshSchematicStrokeStyleEvidence, createFreshSchematicStrokeStyleEvidence,
  FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE as profile, type FreshSchematicStrokeStyleCapture, type FreshSchematicStrokeStyleEvidence,
} from "../../src/harness/fresh-schematic-stroke-style.js";
import { parseFreshSymbolLibraryTerminalGeometrySource, selectFreshSymbolBodyGeometry } from "../../src/harness/fresh-kicad-parser.js";

const native = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/native-schematic-stroke-style.json", import.meta.url), "utf8")) as {
  manifestIdentity: ReturnType<typeof contentIdentity>;
  cli: { bytes: number; sha256: string }; engine: { bytes: number; sha256: string };
  stocks: { file: string; name: string; symbolSha256: string; symbol: string }[];
  cases: { id: string; appMils: number | null; projectMils: number | null; exitCode: number;
    measurements: { id: string; sourceWidthMm: number | null; sourceStroke: string; libraryBody: { strokeWidth: string }[]; documentBody: { strokeWidth: string }[] }[];
    stockMeasurements: { id: string; sourceWidthMm: number; body: { strokeWidth: string }[] }[] }[];
};

/** Trusted-producer-shaped SYNTHETIC capture. Actual expected widths come only from the native fixture above. */
function captureFixture(projectSettingsSource = "{}", applicationSource = "{}", schematic = "synthetic current schematic") {
  const cwd = path.resolve("D:/owned-style-test/project"); const output = path.resolve("D:/owned-style-test/artifacts/render");
  const executablePath = path.resolve("D:/pinned-runtime/kicad-cli.exe");
  const sourceIdentities = { schematic: contentIdentity(schematic), pcb: contentIdentity("synthetic PCB"), projectSettings: contentIdentity(projectSettingsSource) };
  const executable = { kind: "kicad-cli" as const, path: executablePath, version: profile.version, commit: "a".repeat(40),
    sha256: profile.executable.digest, sizeBytes: profile.executable.size, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["sch export svg"] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const svgIdentity = contentIdentity(svg); const configIdentity = contentIdentity(applicationSource);
  const tree = canonicalIdentity({ schemaVersion: "evleda.kicad-schematic-configuration-tree.v1", files: [{ relativePath: "10.0/eeschema.json", identity: configIdentity }], directories: ["10.0"] }, "evleda.kicad-schematic-configuration-tree.v1");
  const capture: FreshSchematicStrokeStyleCapture = {
    render: { classification: "candidate-validation", releaseAuthorized: false, executable, outputDirectory: output,
      sourceHashes: { "test.kicad_sch": sourceIdentities.schematic.digest }, sourceIdentities,
      invocation: { executable, command: executablePath, args: ["sch", "export", "svg", "--output", output, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", path.join(cwd, "test.kicad_sch")],
        cwd, exitCode: 0, stdout: "", stderr: "", durationMs: 1, startedAt: "2026-09-09T12:00:00.000Z" },
      schematicSvg: { path: path.join(output, "test.svg"), relativePath: "test.svg", sha256: svgIdentity.digest, sizeBytes: svgIdentity.size }, source: svg },
    projectSettingsSource,
    schematicEngine: { path: path.join(path.dirname(executablePath), "_eeschema.dll"), before: profile.schematicEngine, after: profile.schematicEngine },
    configuration: { isolation: "caller-owned-isolated", configHome: path.resolve("D:/owned-style-test/config"), treeBefore: tree, treeAfter: tree,
      applicationConfig: { relativePath: "10.0/eeschema.json", source: applicationSource, before: configIdentity, after: configIdentity } },
  };
  return { capture, sourceIdentities };
}
const pin = '(pin passive line (at 10 10 0) (length 2.54) (name "P") (number "1"))';
function graphics(sourceStroke: string) {
  const source = `(kicad_symbol_lib (symbol "Body" (symbol "Body_1_1" ${pin} (rectangle (start -3 -2) (end 3 2) ${sourceStroke} (fill (type none))))))`;
  return selectFreshSymbolBodyGeometry(parseFreshSymbolLibraryTerminalGeometrySource(source, contentIdentity(source), "Test:Body"), 1, 1);
}

describe("native-source/executable/config-bound library body stroke", () => {
  it("pins the independent native matrix and both native executable images", () => {
    expect(native.manifestIdentity).toEqual(profile.nativeObservation);
    expect(native.cli).toMatchObject({ sha256: profile.executable.digest, bytes: profile.executable.size });
    expect(native.engine).toMatchObject({ sha256: profile.schematicEngine.digest, bytes: profile.schematicEngine.size });
    expect(native.cases).toHaveLength(6);
  });
  for (const observed of native.cases) {
    it(`matches every independently observed library stroke in ${observed.id}`, () => {
      expect(observed.exitCode).toBe(0);
      const input = captureFixture(observed.projectMils === null ? "{}" : JSON.stringify({ schematic: { drawing: { default_line_thickness: observed.projectMils } } }),
        observed.appMils === null ? "{}" : JSON.stringify({ drawing: { default_line_thickness: observed.appMils } }));
      const evidence = createFreshSchematicStrokeStyleEvidence(input.capture, input.sourceIdentities);
      expect(evidence.applicationDefaultLineThicknessMils).toBe(observed.appMils);
      expect(evidence.projectDefaultLineThicknessMils).toBe(observed.projectMils);
      for (const measurement of observed.measurements) {
        expect(measurement.libraryBody).toHaveLength(1);
        const sourceGraphics = graphics(measurement.sourceStroke);
        const resolved = applyFreshSchematicStrokeStyle(sourceGraphics, evidence, input.sourceIdentities.schematic)[0]!;
        expect(resolved.unsupportedReason).toBeNull();
        const actualWidth = resolved.centerlineBounds!.minXmm - resolved.bounds!.minXmm - 0.001;
        expect(actualWidth).toBeCloseTo(Number(measurement.libraryBody[0]!.strokeWidth), 10);
      }
    });
  }
  it("retains document-default differences rather than treating them as library rules", () => {
    const changed = native.cases.find((entry) => entry.id === "app20_project12")!;
    const zero = changed.measurements.find((entry) => entry.id === "zero")!;
    expect(zero.libraryBody[0]!.strokeWidth).toBe("0.1524");
    expect(Number(zero.documentBody[0]!.strokeWidth)).toBe(0.3048);
    const invalid = native.cases.find((entry) => entry.id === "app20_project1")!;
    expect(Number(invalid.measurements.find((entry) => entry.id === "zero")!.documentBody[0]!.strokeWidth)).toBe(0.508);
  });
  it.each([
    ["{}", "{}", true],
    ['{"schematic":{"drawing":{"label_size_ratio":0.375,"default_line_thickness":6}}}', '{"appearance":{"default_font":"KiCad Font"},"drawing":{"default_line_thickness":20}}', true],
    ["{}", '{"appearance":{"default_font":"Arial"}}', false],
    ['{"schematic":{"drawing":{"label_size_ratio":0.5}}}', "{}", false],
    ['{"schematic":{"drawing":{"label_size_ratio":"0.375"}}}', "{}", false],
    ['{"schematic":{"drawing":{"default_line_thickness":12}}}', "{}", false],
    ["{}", '{"drawing":{"default_line_thickness":20}}', false],
    ['{"schematic":{"drawing":{"text_offset_ratio":0.08}}}', "{}", false],
    ['{"schematic":{"meta":{"version":1},"drawing":{"text_offset_ratio":0.08}}}', "{}", true],
  ])("keeps label-style qualification distinct from symbol strokes for %s / %s", (project, application, supported) => {
    const input = captureFixture(project as string, application as string);
    const evidence = createFreshSchematicStrokeStyleEvidence(input.capture, input.sourceIdentities);
    expect(evidence.globalLabelPlanning.supported).toBe(supported);
    expect(evidence.symbolDefaultStrokeWidthMm).toBeCloseTo(0.1524, 10);
    expect(Object.isFrozen(evidence.globalLabelPlanning.unsupported)).toBe(true);
  });
  it.each(native.stocks)("preserves actual stock $name graphics and applies renderer rules", (stock) => {
    expect(contentIdentity(stock.symbol).digest).toBe(stock.symbolSha256);
    const nickname = path.basename(stock.file, ".kicad_sym"); const id = `${nickname}:${stock.name}`;
    const source = `(kicad_symbol_lib ${stock.symbol})`;
    const parsed = parseFreshSymbolLibraryTerminalGeometrySource(source, contentIdentity(source), id);
    const sourceGraphics = selectFreshSymbolBodyGeometry(parsed, 1, 1);
    const input = captureFixture(); const evidence = createFreshSchematicStrokeStyleEvidence(input.capture, input.sourceIdentities);
    const resolved = applyFreshSchematicStrokeStyle(sourceGraphics, evidence, input.sourceIdentities.schematic);
    const measured = native.cases[0]!.stockMeasurements.filter((entry) => stock.name === "R" ? entry.id.startsWith("stock_R_") : entry.id.startsWith("stock_Conn_"));
    expect(resolved).toHaveLength(measured.length);
    const actual = resolved.map((graphic) => Number((graphic.centerlineBounds!.minXmm - graphic.bounds!.minXmm - 0.001).toFixed(6))).sort();
    expect(actual).toEqual(measured.map((entry) => Number(entry.body[0]!.strokeWidth)).sort());
  });
  it("keeps zero/omitted strokes unresolved without evidence but retains exact centerlines", () => {
    for (const stroke of ["", "(stroke (type default))", "(stroke (width 0) (type default))"]) {
      expect(graphics(stroke)[0]).toMatchObject({ bounds: null, centerlineBounds: { minXmm: -3, minYmm: -2, maxXmm: 3, maxYmm: 2 }, unsupportedReason: "source-default-stroke-width-unbound" });
    }
  });
  it("binds changed configuration and exact argv into a different evidence identity", () => {
    const a = captureFixture(); const b = captureFixture("{}", '{"drawing":{"default_line_thickness":20}}');
    const first = createFreshSchematicStrokeStyleEvidence(a.capture, a.sourceIdentities); const second = createFreshSchematicStrokeStyleEvidence(b.capture, b.sourceIdentities);
    expect(first.identity).not.toEqual(second.identity);
    expect(first.symbolDefaultStrokeWidthMm).toBe(second.symbolDefaultStrokeWidthMm);
    expect(first.invocationIdentity).toEqual(canonicalIdentity(a.capture.render.invocation, "evleda.kicad-schematic-svg-invocation.v1"));
    expect(Object.isFrozen(first.sourceIdentities.schematic)).toBe(true);
  });
  it("rejects copied, deserialized and source-stale opaque evidence", () => {
    const input = captureFixture(); const evidence = createFreshSchematicStrokeStyleEvidence(input.capture, input.sourceIdentities);
    expect(() => assertFreshSchematicStrokeStyleEvidence({ ...evidence }, input.sourceIdentities.schematic)).toThrow(/forged/u);
    expect(() => assertFreshSchematicStrokeStyleEvidence(JSON.parse(JSON.stringify(evidence)) as FreshSchematicStrokeStyleEvidence, input.sourceIdentities.schematic)).toThrow(/forged/u);
    expect(() => assertFreshSchematicStrokeStyleEvidence(evidence, contentIdentity("new revision"))).toThrow(/stale/u);
  });
  it.each([
    "executable", "engine", "engine path", "version", "argv", "nonzero", "svg", "project", "schematic", "pcb", "config", "tree", "isolation",
  ])("rejects changed or unbound %s evidence", (what) => {
    const input = captureFixture();
    const mutated = structuredClone(input.capture);
    const c = mutated as any; // Deliberate corruptions of private producer-shaped evidence.
    if (what === "executable") c.render.executable.sha256 = "f".repeat(64);
    if (what === "engine") c.schematicEngine.after.digest = "f".repeat(64);
    if (what === "engine path") c.schematicEngine.path = path.resolve("D:/other/_eeschema.dll");
    if (what === "version") c.render.executable.version = "10.0.4";
    if (what === "argv") c.render.invocation.args.splice(8, 0, "--min-pen-width", "1");
    if (what === "nonzero") c.render.invocation.exitCode = 1;
    if (what === "svg") c.render.source += " ";
    if (what === "project") c.projectSettingsSource = '{"changed":true}';
    if (what === "schematic") c.render.sourceIdentities.schematic.digest = "f".repeat(64);
    if (what === "pcb") c.render.sourceIdentities.pcb.digest = "f".repeat(64);
    if (what === "config") c.configuration.applicationConfig.source = '{"changed":true}';
    if (what === "tree") c.configuration.treeAfter = { ...c.configuration.treeAfter, digest: "f".repeat(64) };
    if (what === "isolation") c.configuration.isolation = "ambient";
    expect(() => createFreshSchematicStrokeStyleEvidence(mutated, input.sourceIdentities)).toThrow(/stroke style/u);
  });
  it.each(['{"drawing":{"default_line_thickness":6,"default_line_thickness":20}}', '{"drawing":{"default_line_thickness":"6"}}', '{"drawing":{"default_line_thickness":0}}', '{"drawing":[]}'])
    ("rejects malformed bound settings even when the supplied hash matches", (config) => {
      const input = captureFixture("{}", config);
      expect(() => createFreshSchematicStrokeStyleEvidence(input.capture, input.sourceIdentities)).toThrow();
    });
  it("cannot turn unsupported graphic text into a measured body", () => {
    const source = `(kicad_symbol_lib (symbol "Body" (symbol "Body_1_1" ${pin} (text "NOT MEASURED" (at 0 0 0)))))`;
    const g = selectFreshSymbolBodyGeometry(parseFreshSymbolLibraryTerminalGeometrySource(source, contentIdentity(source), "Test:Body"), 1, 1);
    const input = captureFixture(); const evidence = createFreshSchematicStrokeStyleEvidence(input.capture, input.sourceIdentities);
    expect(applyFreshSchematicStrokeStyle(g, evidence, input.sourceIdentities.schematic)[0]).toMatchObject({ bounds: null, unsupportedReason: "graphic-text-requires-native-font" });
  });
});

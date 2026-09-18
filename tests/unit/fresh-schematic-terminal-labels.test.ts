import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION, type FreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { buildSchematicTerminalGroups, type FreshSchematicTerminalPartition } from "../../src/harness/fresh-schematic-terminal-groups.js";
import { planFreshTerminalGlobalLabels, type FreshTerminalLabelObstacle } from "../../src/harness/fresh-schematic-terminal-labels.js";
import { freshSavedTerminalGlobalLabelsMatch, freshTerminalGlobalLabelSourceMatches } from "../../src/harness/fresh-schematic-terminal-label-source.js";
import { freshGlobalLabelInventoryMatches, freshGlobalLabelTupleInventoryMatches, parseFreshSchematicSource, parseFreshSymbolLibraryTerminalGeometrySource } from "../../src/harness/fresh-kicad-parser.js";
import { createFreshSchematicStrokeStyleEvidence, FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE as profile } from "../../src/harness/fresh-schematic-stroke-style.js";
import { FreshSchematicWorkBudget } from "../../src/harness/fresh-schematic-work-budget.js";

const sheet = { minX: 15.24, minY: 15.24, maxX: 279.4, maxY: 195.58 };
const round = (value: number) => Number(value.toFixed(4));
function fixture(count = 2, withStacks = true, bodyStyle: 1 | 2 = 1, reverseEmbeddedPins = false) {
  const components = Array.from({ length: count }, (_, index) => ({ reference: `U${index + 1}`,
    symbolLibId: withStacks && index < Math.min(14, count) ? "Test:Five" : "Test:Four", value: "SYNTHETIC", footprintLibId: "Test:Footprint" }));
  const placements = components.map((component, index) => ({ reference: component.reference,
    x: round(30.48 + index % 9 * 25.4), y: round(30.48 + Math.floor(index / 9) * 22.86) }));
  const locals = (libraryId: string) => [-7.62, -2.54, 2.54, 7.62, ...(libraryId === "Test:Five" ? [-7.62] : [])]
    .map((y, index) => ({ number: String(index + 1), at: { xMm: -3.81, yMm: -y }, angleDeg: 0 as const }));
  const noConnects = [{ reference: components.at(-1)!.reference, pin: "3" }, { reference: components.at(-1)!.reference, pin: "4" }];
  const endpoints = components.flatMap(component => locals(component.symbolLibId).map(pin => ({ reference: component.reference, pin: pin.number })));
  const isNc = (point: { reference: string; pin: string }) => noConnects.some(value => value.reference === point.reference && value.pin === point.pin);
  const nameOf = (pin: string) => ["1", "2", "5"].includes(pin) ? "N" : "P";
  const nets = ["N", "P"].map(name => ({ name, endpoints: endpoints.filter(point => !isNc(point) && nameOf(point.pin) === name) })).filter(net => net.endpoints.length > 0);
  const payload = { schemaVersion: FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION,
    sourceContractIdentity: canonicalIdentity({ components, nets, noConnects }, "test.terminal-label-contract.v1"), components, nets, noConnects };
  const contract: FreshConnectivityContract = { ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) };
  const definitions = ["Test:Four", "Test:Five"].map(libraryId => {
    const leaf = libraryId.split(":")[1]!;
    return `(symbol "${libraryId}" (symbol "${leaf}_0_1" (rectangle (start -1.27 -8.89) (end 1.27 8.89) (stroke (width 0.1524) (type default)) (fill (type none))))
      ${(bodyStyle === 2 ? [1, 2] : [1]).map(style => `(symbol "${leaf}_1_${style}" ${locals(libraryId).map(pin => `(pin passive line (at ${pin.at.xMm} ${pin.at.yMm} 0) (length 2.54) (name "P${pin.number}") (number "${pin.number}"))`).join(" ")})`).join(" ")})`;
  });
  const embedded = definitions.map(definition => {
    if (!reverseEmbeddedPins) return definition;
    const pattern = /\(pin passive line \(at [^)]+\) \(length 2\.54\) \(name "[^"]+"\) \(number "[^"]+"\)\)/gu;
    const reversed = [...definition.matchAll(pattern)].map(value => value[0]).reverse();
    return definition.replace(pattern, () => reversed.shift()!);
  });
  const instances = components.map((component, index) => `(symbol (lib_id "${component.symbolLibId}") (unit 1) (body_style ${bodyStyle}) (at ${placements[index]!.x} ${placements[index]!.y} 0)
    (property "Reference" "${component.reference}") (property "Value" "${component.value}") (property "Footprint" "${component.footprintLibId}"))`).join("\n");
  const source = (extra = "") => `(kicad_sch (version 20250114) (lib_symbols ${embedded.join(" ")}) ${instances} ${extra})`;
  const pristine = source();
  const pins = new Map(components.flatMap((component, index) => locals(component.symbolLibId).map(pin => [`${component.reference}:${pin.number}`,
    { x: round(placements[index]!.x + pin.at.xMm), y: round(placements[index]!.y - pin.at.yMm), angleDeg: 0 as const }] as const)));
  const boxes: FreshTerminalLabelObstacle[] = placements.map(value => ({ reference: value.reference,
    minX: round(value.x - 3.81), maxX: round(value.x + 1.27), minY: round(value.y - 8.89), maxY: round(value.y + 8.89) }));
  const partitionFor = (saved: string): FreshSchematicTerminalPartition => {
    const result = buildSchematicTerminalGroups({ contractIdentity: contract.sourceContractIdentity,
      components: components.map((component, index) => ({ reference: component.reference, symbolLibId: component.symbolLibId, unit: 1,
        sourceIdentity: contentIdentity(saved), placement: { at: { xMm: placements[index]!.x, yMm: placements[index]!.y }, rotationDeg: 0 }, pins: locals(component.symbolLibId) })),
      assignments: endpoints.map(endpoint => ({ ...endpoint, assignment: isNc(endpoint) ? { kind: "no_connect" as const } : { kind: "net" as const, net: nameOf(endpoint.pin) } })),
      livePins: [...pins].map(([endpoint, value]) => ({ reference: endpoint.split(":")[0]!, pin: endpoint.split(":")[1]!, at: { xMm: value.x, yMm: value.y }, angleDeg: value.angleDeg })),
    });
    if (result.status !== "complete") throw new Error(JSON.stringify(result));
    return result.value;
  };
  const partition = partitionFor(pristine);
  const resolver = { resolveSymbol: () => null, resolveFootprint: () => null,
    inspectSymbolTerminalGeometry: (libraryId: string) => {
      const definition = definitions[["Test:Four", "Test:Five"].indexOf(libraryId)];
      if (definition === undefined) return null;
      const library = `(kicad_symbol_lib ${definition.replace(`"${libraryId}"`, `"${libraryId.split(":")[1]}"`)})`;
      return parseFreshSymbolLibraryTerminalGeometrySource(library, contentIdentity(library), libraryId);
    } };
  const plan = (budget = new FreshSchematicWorkBudget(), obstacles = boxes) => planFreshTerminalGlobalLabels({ contract, partition,
    sourceIdentity: contentIdentity(pristine), pins, boxes: obstacles, sheet }, budget);
  const saved = (result = plan()) => source([...result.wires.map(wire => `(wire (pts (xy ${wire.x} ${wire.y}) (xy ${wire.endX} ${wire.endY})))`),
    ...result.labels.map(label => `(global_label "${label.name}" (shape passive) (at ${label.at.x} ${label.at.y} ${label.rotationDeg}) (effects (font (size 1.524 1.524)) (justify ${label.justify})))`),
    ...noConnects.map(endpoint => { const pin = pins.get(`${endpoint.reference}:${endpoint.pin}`)!; return `(no_connect (at ${pin.x} ${pin.y}))`; })].join("\n"));
  return { contract, pins, boxes, partition, partitionFor, pristine, plan, source, saved, resolver, endpoints };
}

function styleFor(source: string, applicationSource = "{}") {
  const schematic = contentIdentity(source), projectSettingsSource = "{}";
  const executablePath = path.resolve("D:/pinned-terminal-label/kicad-cli.exe"), cwd = path.resolve("D:/terminal-label/project"), output = path.resolve("D:/terminal-label/render");
  const executable = { kind: "kicad-cli" as const, path: executablePath, version: profile.version, commit: "a".repeat(40), sha256: profile.executable.digest,
    sizeBytes: profile.executable.size, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["sch export svg"] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>', nativeSvg = contentIdentity(svg), config = contentIdentity(applicationSource);
  const sources = { schematic, pcb: contentIdentity("synthetic PCB"), projectSettings: contentIdentity(projectSettingsSource) };
  const tree = canonicalIdentity({ schemaVersion: "evleda.kicad-schematic-configuration-tree.v1", files: [{ relativePath: "10.0/eeschema.json", identity: config }], directories: ["10.0"] }, "evleda.kicad-schematic-configuration-tree.v1");
  return createFreshSchematicStrokeStyleEvidence({ projectSettingsSource,
    render: { classification: "candidate-validation", releaseAuthorized: false, executable, outputDirectory: output, sourceHashes: { "test.kicad_sch": schematic.digest }, sourceIdentities: sources,
      invocation: { executable, command: executablePath, args: ["sch", "export", "svg", "--output", output, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", path.join(cwd, "test.kicad_sch")], cwd, exitCode: 0, stdout: "", stderr: "", durationMs: 1, startedAt: "2026-09-17T12:00:00.000Z" },
      schematicSvg: { path: path.join(output, "test.svg"), relativePath: "test.svg", sha256: nativeSvg.digest, sizeBytes: nativeSvg.size }, source: svg },
    schematicEngine: { path: path.join(path.dirname(executablePath), "_eeschema.dll"), before: profile.schematicEngine, after: profile.schematicEngine },
    configuration: { isolation: "caller-owned-isolated", configHome: path.resolve("D:/terminal-label/config"), treeBefore: tree, treeAfter: tree,
      applicationConfig: { relativePath: "10.0/eeschema.json", source: applicationSource, before: config, after: config } },
  }, sources);
}

describe("bounded source-qualified repeated terminal labels (synthetic, no native execution)", () => {
  it("plans 62 components, 246 functional groups and all 260 connected endpoints plus two NCs within the existing budget", () => {
    const f = fixture(62), budget = new FreshSchematicWorkBudget(), result = f.plan(budget);
    expect(result.issues).toEqual([]); expect(result.labels).toHaveLength(246); expect(result.wires).toHaveLength(246);
    expect(f.endpoints).toHaveLength(262); expect(f.contract.noConnects).toHaveLength(2);
    expect(result.wires.flatMap(wire => wire.edgeEndpoints)).toHaveLength(260);
    expect(new Set(result.wires.flatMap(wire => wire.edgeEndpoints)).size).toBe(260);
    expect(budget.snapshot().consumed).toBeLessThan(1_000_000);
    expect(result.wires.every(wire => wire.endX !== wire.x && wire.endY === wire.y)).toBe(true);
    expect(result.labels.every(label => label.fontMm === 1.524)).toBe(true);
    const saved = f.saved(result);
    expect(freshSavedTerminalGlobalLabelsMatch(saved, f.contract, f.resolver, result.labels)).toBe(true);
  });
  it("retains 1.27 mm short stubs and validates repeated names by full tuples without changing legacy names-only behavior", () => {
    const f = fixture(), result = f.plan(), source = f.saved(result), schematic = parseFreshSchematicSource(source);
    expect(result.issues).toEqual([]);
    expect(result.wires.every(wire => Math.abs(wire.endX - wire.x - -1.27) < 1e-9)).toBe(true);
    expect(freshGlobalLabelInventoryMatches(schematic, f.contract.nets.map(net => net.name))).toBe(false);
    expect(freshGlobalLabelTupleInventoryMatches(schematic, result.labels)).toBe(true);
    expect(freshSavedTerminalGlobalLabelsMatch(source, f.contract, f.resolver, result.labels)).toBe(true);
  });
  it.each([1, 2] as const)("preserves selected body %s and order-independent complete pin facts in saved reconstruction", bodyStyle => {
    const f = fixture(2, true, bodyStyle, true), result = f.plan();
    expect(result.issues).toEqual([]);
    expect(freshSavedTerminalGlobalLabelsMatch(f.saved(result), f.contract, f.resolver, result.labels)).toBe(true);
  });
  it("uses 2.54 mm when a real glyph obstructs the first label anchor", () => {
    const f = fixture(), pin = f.pins.get("U1:1")!;
    const result = f.plan(undefined, [...f.boxes, { reference: "@glyph", minX: pin.x - 1.4, maxX: pin.x - 1.2, minY: pin.y + 0.2, maxY: pin.y + 0.4 }]);
    expect(result.issues).toEqual([]);
    expect(result.labels[0]!.at.x).toBe(round(pin.x - 2.54));
    // A glyph on the terminal branch itself is never exempted.
    const blocked = f.plan(undefined, [...f.boxes, { reference: "@glyph", minX: pin.x - 1.1, maxX: pin.x - 0.9, minY: pin.y - 0.2, maxY: pin.y + 0.2 }]);
    expect(blocked.wires).toEqual([]); expect(blocked.issues[0]!.code).toBe("TERMINAL_LABEL_SPACE_UNAVAILABLE");
  });
  it("only exits the verified own pin stroke margin; actual body and native glyph ink stay strict", () => {
    const f = fixture(), strokeStyle = styleFor(f.pristine), tip = Math.max(strokeStyle.symbolDefaultStrokeWidthMm, strokeStyle.minimumPlotStrokeWidthMm) + 0.001;
    const boxes = f.boxes.map(box => ({ ...box, minX: box.minX - tip, maxX: box.maxX + tip, minY: box.minY - tip, maxY: box.maxY + tip }));
    const sourceBodyBoxes = f.boxes.map(box => ({ ...box, reference: `@body:${box.reference}`, minX: box.minX + 2.54 }));
    const input = { contract: f.contract, partition: f.partition, sourceIdentity: contentIdentity(f.pristine), pins: f.pins, boxes, sheet, strokeStyle, sourceBodyBoxes };
    expect(planFreshTerminalGlobalLabels(input).issues).toEqual([]);
    expect(planFreshTerminalGlobalLabels({ ...input, boxes: boxes.map(box => ({ ...box, minX: box.minX - 0.1 })) }).wires).toEqual([]);
    const pin = f.pins.get("U1:1")!;
    expect(planFreshTerminalGlobalLabels({ ...input, sourceBodyBoxes: [...sourceBodyBoxes, { reference: "@body:intrusion", minX: pin.x - 0.1, maxX: pin.x + 0.1, minY: pin.y - 0.1, maxY: pin.y + 0.1 }] }).wires).toEqual([]);
    expect(planFreshTerminalGlobalLabels({ ...input, strokeStyle: styleFor(f.pristine + " ") }).issues[0]!.code).toBe("TERMINAL_LABEL_SOURCE_MISMATCH");
  });
  it("fails closed on missing/stale terminal evidence and exhaustion without a partial plan", () => {
    const f = fixture();
    expect(f.plan(new FreshSchematicWorkBudget(5)).issues[0]!.code).toBe("PLANNING_WORK_LIMIT");
    f.pins.delete("U1:5");
    expect(f.plan().issues[0]!.code).toBe("TERMINAL_LABEL_SOURCE_MISMATCH");
  });
  it("rejects a current but unsupported native label font before returning wires", () => {
    const f = fixture();
    const result = planFreshTerminalGlobalLabels({ contract: f.contract, partition: f.partition, sourceIdentity: contentIdentity(f.pristine),
      pins: f.pins, boxes: f.boxes, sheet, sourceBodyBoxes: [], strokeStyle: styleFor(f.pristine, '{"appearance":{"default_font":"Arial"}}') });
    expect(result).toMatchObject({ wires: [], labels: [], issues: [{ code: "TERMINAL_LABEL_SOURCE_MISMATCH" }] });
  });
  it.each([[90, "left", "bottom"], [270, "right", "top"]] as const)("accepts stock vertical justification %s and rejects the old centered form", (rotation, justify, previous) => {
    const f = fixture(), result = f.plan(), first = result.labels[0]!;
    const saved = f.saved(result).replace(`(at ${first.at.x} ${first.at.y} 180)`, `(at ${first.at.x} ${first.at.y} ${rotation})`)
      .replace("(justify right)", `(justify ${justify})`);
    // Electrical reconstruction alone is not a clearance certificate; the caller
    // separately compares the expected planned tuples and the current native ink.
    expect(freshSavedTerminalGlobalLabelsMatch(saved, f.contract, f.resolver)).toBe(true);
    expect(freshSavedTerminalGlobalLabelsMatch(saved.replace(`(justify ${justify})`, `(justify ${previous})`), f.contract, f.resolver)).toBe(false);
    expect(freshSavedTerminalGlobalLabelsMatch(saved, f.contract, f.resolver, result.labels)).toBe(false);
  });
  it.each(["float", "duplicate-anchor", "foreign-name", "font", "face", "color", "rotation", "shape", "bold", "nc", "missing-nc", "source-pin", "cross-net"])("rejects saved %s despite same-name native union", kind => {
    const f = fixture(), result = f.plan(), first = result.labels[0]!, pin = f.pins.get("U1:1")!;
    let saved = f.saved(result);
    if (kind === "float") saved = saved.replace(`(at ${first.at.x} ${first.at.y} ${first.rotationDeg})`, `(at ${first.at.x} ${first.at.y - 1.27} ${first.rotationDeg})`);
    if (kind === "duplicate-anchor") saved = saved.replace(`(at ${result.labels[1]!.at.x} ${result.labels[1]!.at.y} 180)`, `(at ${first.at.x} ${first.at.y} 180)`);
    if (kind === "foreign-name") saved = saved.replace('(global_label "N"', '(global_label "FOREIGN"');
    if (kind === "font") saved = saved.replace("1.524 1.524", "1.27 1.27");
    if (kind === "face") saved = saved.replace("(size 1.524 1.524)", '(size 1.524 1.524) (face "Unapproved Font")');
    if (kind === "color") saved = saved.replace("(justify right)", "(justify right) (color 1 1 1 0)");
    if (kind === "rotation") saved = saved.replace(`(at ${first.at.x} ${first.at.y} 180)`, `(at ${first.at.x} ${first.at.y} 0)`);
    if (kind === "shape") saved = saved.replace("(shape passive)", "(shape input)");
    if (kind === "bold") saved = saved.replace("(size 1.524 1.524)", "(size 1.524 1.524) (bold yes)");
    if (kind === "missing-nc") saved = saved.replace(/\(no_connect \(at [^)]+\)\)/u, "");
    if (kind === "source-pin") saved = saved.replaceAll('(name "P1")', '(name "UNAPPROVED")');
    if (kind === "nc") { const nc = f.pins.get("U2:3")!; saved = saved.slice(0, -1) + `(wire (pts (xy ${nc.x} ${nc.y}) (xy ${nc.x - 1.27} ${nc.y}))))`; }
    if (kind === "cross-net") { const other = f.pins.get("U1:3")!; saved = saved.slice(0, -1) + `(wire (pts (xy ${pin.x} ${pin.y}) (xy ${other.x} ${other.y}))))`; }
    expect(freshSavedTerminalGlobalLabelsMatch(saved, f.contract, f.resolver)).toBe(false);
  });
  it("rejects stale source partitions and floating wire islands", () => {
    const f = fixture(), saved = f.saved();
    expect(freshTerminalGlobalLabelSourceMatches({ source: saved, contract: f.contract, partition: f.partition })).toBe(false);
    const floating = saved.slice(0, -1) + '(wire (pts (xy 200 150) (xy 201.27 150))))';
    expect(freshSavedTerminalGlobalLabelsMatch(floating, f.contract, f.resolver)).toBe(false);
  });
});

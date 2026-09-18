import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { KicadSchematicSvgResult } from "../../src/integrations/kicad-cli.js";
import {
  analyzeNativeSchematicSvg, createSchematicRenderClearanceEvidence, verifySchematicRenderClearanceEvidence,
  verifyHostSchematicRenderClearanceEvidence, SCHEMATIC_RENDER_CLEARANCE_POLICY, type SchematicRenderClearanceExpected,
  collectNativeSchematicTextBounds,
} from "../../src/integrations/schematic-render-clearance.js";

const style = 'fill="none" stroke="#000000" stroke-width="0.2" stroke-linecap="round" stroke-linejoin="round"';
const svg = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><g ${style}>${body}</g></svg>`;
const text = (name: string, d: string): string => `<text x="1" y="1" opacity="0">${name}</text><g class="stroked-text"><desc>${name}</desc><path d="${d}"/></g>`;
const clear = svg(`${text("R1", "M1 1 L2 1")}<path d="M8 8 L9 8"/>`);
const sources = { schematic: contentIdentity("schematic"), pcb: contentIdentity("board"), projectSettings: contentIdentity("settings") };
const executable = { kind: "kicad-cli" as const, path: "C:/pinned/kicad-cli.exe", version: "10.0.3", commit: "test", sha256: "a".repeat(64), sizeBytes: 100, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["sch export svg"] };
const expected: SchematicRenderClearanceExpected = {
  sources, executable,
  validationSourceBindingIdentity: canonicalIdentity({ unchanged: true, sources }, "evleda.pcb-harness-validation-source-binding.v1"),
};
const capture = (source = clear): KicadSchematicSvgResult => ({
  classification: "candidate-validation", releaseAuthorized: false, executable, outputDirectory: "C:/private/svg",
  sourceHashes: { "board.kicad_sch": sources.schematic.digest, "board.kicad_pcb": sources.pcb.digest, "board.kicad_pro": sources.projectSettings.digest }, sourceIdentities: sources,
  invocation: { executable, command: executable.path, args: ["sch", "export", "svg", "--output", "C:/private/svg", "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", "C:/private/board.kicad_sch"], cwd: "C:/private", exitCode: 0, stdout: "native export", stderr: "", durationMs: 1, startedAt: "2026-09-09T00:00:00.000Z" },
  schematicSvg: { path: "C:/private/svg/board.svg", relativePath: "board.svg", sha256: contentIdentity(source).digest, sizeBytes: Buffer.byteLength(source) }, source,
});

describe("source-bound native schematic ink clearance", () => {
  it("replays all 554 genuine RP2350 glyph groups without claiming unsupported body-ink coverage", async () => {
    const bytes = gunzipSync(await readFile(new URL("../fixtures/fresh-project/rp2350-native-62-component-schematic.svg.gz", import.meta.url)));
    expect(contentIdentity(bytes)).toMatchObject({ digest: "1a33efe129206d83926c7c73df2c45d156ef565b7c9750d06de560283cb90b24", size: 1_181_482 });
    const source = bytes.toString("utf8"), planning = collectNativeSchematicTextBounds(source);
    expect(planning).toMatchObject({ completeCoverage: true, hasText: true, unsupported: [] });
    expect(planning.bounds).toHaveLength(554);
    expect(planning.bounds.map(group => group.textGroupIndex)).toEqual(Array.from({ length: 554 }, (_, index) => index));
    expect(planning.bounds.find(group => group.elementIndex === 50)?.text).toBe("GND");
    const full = analyzeNativeSchematicSvg(source);
    expect(full).toMatchObject({ completeCoverage: false, textGroupCount: 554, primitiveCount: 19_463 });
    expect(full.unsupported.map(problem => problem.code)).toEqual(expect.arrayContaining([
      "UNSUPPORTED_PATH_COMMAND", "FILLED_PATH_UNSUPPORTED", "UNSUPPORTED_FILL_RULE", "COLLISION_WORK_LIMIT",
    ]));
  });

  it("admits the exact XML element ceiling and rejects one additional element", () => {
    const source = svg(text("A", "M1 1 L2 1") + "<g/>".repeat(SCHEMATIC_RENDER_CLEARANCE_POLICY.maxElements - 6));
    expect(collectNativeSchematicTextBounds(source)).toMatchObject({ completeCoverage: true, unsupported: [] });
    expect(analyzeNativeSchematicSvg(source)).toMatchObject({ status: "pass", completeCoverage: true });
    const excess = source.replace("</svg>", "<g/></svg>");
    for (const result of [collectNativeSchematicTextBounds(excess), analyzeNativeSchematicSvg(excess)]) {
      expect(result).toMatchObject({ completeCoverage: false, unsupported: [expect.objectContaining({ code: "SVG_STRUCTURE_LIMIT" })] });
    }
  });

  it("admits exact byte capacity and rejects the next byte before collecting glyphs", () => {
    const source = clear.replace("</svg>", `<!--${" ".repeat(SCHEMATIC_RENDER_CLEARANCE_POLICY.maxSvgBytes - Buffer.byteLength(clear) - 7)}--></svg>`);
    expect(Buffer.byteLength(source)).toBe(SCHEMATIC_RENDER_CLEARANCE_POLICY.maxSvgBytes);
    expect(collectNativeSchematicTextBounds(source).completeCoverage).toBe(true);
    expect(analyzeNativeSchematicSvg(source).completeCoverage).toBe(true);
    for (const result of [collectNativeSchematicTextBounds(source + " "), analyzeNativeSchematicSvg(source + " ")]) {
      expect(result).toMatchObject({ completeCoverage: false, unsupported: [expect.objectContaining({ code: "SVG_BYTE_LIMIT_OR_INVALID_UNICODE" })] });
    }
  });

  it("retains the existing depth, text-group and segment ceilings", () => {
    const depth = svg(text("A", "M1 1 L2 1") + "<g>".repeat(30) + "</g>".repeat(30));
    expect(SCHEMATIC_RENDER_CLEARANCE_POLICY).toMatchObject({ maxDepth: 32, maxTextGroups: 1000, maxSegments: 30000, maxComparisons: 2000000 });
    expect(collectNativeSchematicTextBounds(depth).completeCoverage).toBe(true);
    expect(collectNativeSchematicTextBounds(depth.replace("<g><g>", "<g><g><g>").replace("</g></g>", "</g></g></g>")))
      .toMatchObject({ completeCoverage: false, unsupported: [expect.objectContaining({ code: "SVG_STRUCTURE_LIMIT" })] });
    const groups = Array.from({ length: 1000 }, (_, index) => text(`G${index}`, "M1 1 L2 1")).join("");
    expect(collectNativeSchematicTextBounds(svg(groups)).bounds).toHaveLength(1000);
    expect(collectNativeSchematicTextBounds(svg(groups + text("EXTRA", "M1 1 L2 1"))))
      .toMatchObject({ completeCoverage: false, unsupported: [expect.objectContaining({ code: "SVG_TEXT_GROUP_LIMIT" })] });
    const segments = svg(text("A", "M1 1 L2 1").replace('<path d="M1 1 L2 1"/>', '<path d="M1 1 L2 1"/>'.repeat(30000)));
    expect(collectNativeSchematicTextBounds(segments).completeCoverage).toBe(true);
    expect(collectNativeSchematicTextBounds(segments.replace('<path d="M1 1 L2 1"/>', '<path d="M1 1 L2 1"/><path d="M1 1 L2 1"/>')))
      .toMatchObject({ completeCoverage: false, unsupported: [expect.objectContaining({ code: "SVG_PRIMITIVE_LIMIT" })] });
  });

  it.each([-270, -180, -90, 0, 90, 180, 270])("pairs invisible metadata rotated %d degrees without rotating absolute glyph ink", angle => {
    const source = svg(`<g transform="rotate(${angle} 40 50)"><text x="40" y="50" opacity="0" stroke-opacity="0">R1</text></g>`
      + '<g class="stroked-text"><desc>R1</desc><path d="M5 5 L6 5"/></g>');
    expect(collectNativeSchematicTextBounds(source)).toMatchObject({ completeCoverage: true, unsupported: [],
      bounds: [{ text: "R1", minX: 4.9, maxX: 6.1, minY: 4.9, maxY: 5.1 }] });
    expect(analyzeNativeSchematicSvg(source)).toMatchObject({ completeCoverage: true, status: "pass" });
  });

  it.each([
    'rotate(-90,,40,50)', 'rotate(-90,40,50,)', 'rotate(,-90,40,50)', 'rotate(-90 40)',
    'rotate(-91 40 50)', 'rotate(-90 40 50) translate(0 0)', 'rotate(-90 1e309 50)',
  ])("rejects malformed or unsupported hidden metadata transform %s", transform => {
    const source = svg(`<g transform="${transform}"><text x="40" y="50" opacity="0" stroke-opacity="0">R1</text></g>`
      + '<g class="stroked-text"><desc>R1</desc><path d="M5 5 L6 5"/></g>');
    expect(collectNativeSchematicTextBounds(source).completeCoverage).toBe(false);
    expect(analyzeNativeSchematicSvg(source).completeCoverage).toBe(false);
  });

  it("rejects visible, mixed, nested, unpaired or mismatched rotated metadata", () => {
    const hidden = '<text x="40" y="50" opacity="0" stroke-opacity="0">R1</text>';
    const wrapper = `<g transform="rotate(-90 40 50)">${hidden}</g>`;
    const glyph = '<g class="stroked-text"><desc>R1</desc><path d="M5 5 L6 5"/></g>';
    for (const body of [
      wrapper.replace('opacity="0"', 'opacity="1"') + glyph,
      wrapper.replace('opacity="0"', 'opacity="0" style="opacity:1"') + glyph,
      wrapper.replace(' stroke-opacity="0"', '') + glyph,
      wrapper.replace('</g>', '<path d="M8 8 L9 8"/></g>') + glyph,
      wrapper.replace(hidden, hidden + hidden) + glyph,
      wrapper.replace(hidden, `<g>${hidden}</g>`) + glyph,
      wrapper.replace('<g transform=', '<g clip-path="url(#clip)" transform=') + glyph,
      wrapper + glyph.replace('<desc>R1</desc>', '<desc>wrong</desc>'),
      wrapper + '<g/>' + glyph,
      wrapper,
    ]) {
      // An unrelated good group must not mask missing wrapper-to-glyph pairing.
      const source = svg(body + text("GOOD", "M80 80 L81 80"));
      expect(collectNativeSchematicTextBounds(source).completeCoverage, body).toBe(false);
      expect(analyzeNativeSchematicSvg(source).completeCoverage, body).toBe(false);
    }
  });

  it("accepts evenodd only on a nonglyph leaf already outside planning geometry scope", () => {
    const body = '<path d="M10 10 L12 10 L11 12 Z" fill="black" fill-rule="evenodd"/>';
    expect(collectNativeSchematicTextBounds(svg(text("A", "M1 1 L2 1") + body))).toMatchObject({ completeCoverage: true, unsupported: [] });
    expect(analyzeNativeSchematicSvg(svg(text("A", "M1 1 L2 1") + body)).unsupported)
      .toContainEqual(expect.objectContaining({ code: "UNSUPPORTED_FILL_RULE" }));
    for (const source of [
      svg(text("A", "M1 1 L2 1").replace('<path ', '<path fill-rule="evenodd" ')),
      svg(`<g fill-rule="evenodd">${text("A", "M1 1 L2 1")}</g>`),
      svg(text("A", "M1 1 L2 1") + body.replace('evenodd', 'unknown')),
      svg(text("A", "M1 1 L2 1") + body.replace('/>', '><path d="M1 1 L2 1"/></path>')),
    ]) expect(collectNativeSchematicTextBounds(source).completeCoverage).toBe(false);
  });

  it("does not reproduce receipts bound to the old XML capacity policy", () => {
    const evidence = createSchematicRenderClearanceEvidence(capture(), expected);
    const { hiddenTextMetadata: _metadata, planningOnlyNontextLeafFillRules: _fillRules, ...policy } = SCHEMATIC_RENDER_CLEARANCE_POLICY;
    const oldPolicy = { ...policy, maxSvgBytes: 2 * 1024 * 1024, maxElements: 20000 };
    const oldReceipt = { ...evidence, policyIdentity: canonicalIdentity(oldPolicy, oldPolicy.schemaVersion) };
    expect(() => verifySchematicRenderClearanceEvidence(oldReceipt, capture(), expected)).toThrow(/does not reproduce/);
  });

  it("retains every glyph group as independent planning ink without assigning repeated pin numbers or custom fields", () => {
    const source = svg(text("1", "M1 1 L2 1") + text("1", "M5 5 L6 5") + text("MPN custom field", "M10 10 L12 10"));
    const result = collectNativeSchematicTextBounds(source);
    expect(result).toMatchObject({ completeCoverage: true, hasText: true, unsupported: [] });
    expect(result.bounds).toEqual([
      expect.objectContaining({ textGroupIndex: 0, text: "1", minX: 0.9, maxX: 2.1, minY: 0.9, maxY: 1.1 }),
      expect.objectContaining({ textGroupIndex: 1, text: "1", minX: 4.9, maxX: 6.1 }),
      expect.objectContaining({ textGroupIndex: 2, text: "MPN custom field", minX: 9.9, maxX: 12.1 }),
    ]);
    expect(Object.isFrozen(result.bounds[0])).toBe(true);
  });

  it("keeps text coverage separate from source-qualified nontext arcs", () => {
    const source = svg(text("R1", "M1 1 L2 1") + '<path d="M10 10 A2 2 0 0 0 12 12"/>');
    expect(collectNativeSchematicTextBounds(source)).toMatchObject({ completeCoverage: true, unsupported: [] });
    expect(analyzeNativeSchematicSvg(source).completeCoverage).toBe(false);
  });

  it.each([
    svg('<g transform="translate(1 0)">' + text("R1", "M1 1 L2 1") + '</g>'),
    svg('<g class="stroked-text"><desc>unpaired</desc><path d="M1 1 L2 1"/></g>'),
    svg(text("custom", "M1 1 C2 2 3 3 4 4")),
    svg('<text x="1" y="1">unsupported real font</text>'),
    svg('<g clip-path="url(#clip)">' + text("1", "M1 1 L2 1") + '</g>'),
  ])("refuses incomplete or unsupported native planning text coverage", source => {
    expect(collectNativeSchematicTextBounds(source)).toMatchObject({ completeCoverage: false, hasText: true });
  });

  it("detects actual attempt14 native glyph collisions without estimating text boxes", async () => {
    const normalized = await readFile(new URL("../fixtures/fresh-project/attempt14-native-schematic.svg", import.meta.url), "utf8");
    const native = normalized.replace(/\r?\n/gu, "\r\n");
    expect(contentIdentity(native)).toMatchObject({ digest: "e6fea2c7a10bb5811ac2504d1888c60db310f134e08bc430eb27980823797e57", size: 20392 });
    const result = analyzeNativeSchematicSvg(native);
    expect(result).toMatchObject({ status: "fail", completeCoverage: true, textGroupCount: 12, primitiveCount: 322, unsupported: [] });
    expect(result.collisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text-text", a: expect.objectContaining({ text: "1", textGroupIndex: 0 }), b: expect.objectContaining({ text: "VIN", textGroupIndex: 11 }) }),
      expect.objectContaining({ kind: "text-geometry", a: expect.objectContaining({ text: "J1", textGroupIndex: 3 }) }),
      expect.objectContaining({ kind: "text-geometry", a: expect.objectContaining({ text: "DIVIDER_IO", textGroupIndex: 4 }) }),
      expect.objectContaining({ kind: "text-geometry", a: expect.objectContaining({ text: "10k", textGroupIndex: 6 }) }),
      expect.objectContaining({ kind: "text-geometry", a: expect.objectContaining({ text: "10k", textGroupIndex: 8 }) }),
    ]));
    expect(result.collisions.every((entry) => Number.isInteger(entry.a.elementIndex) && Number.isInteger(entry.b.elementIndex))).toBe(true);
  });

  it("passes separated native strokes with bounded, explicitly scoped coverage", () => {
    expect(analyzeNativeSchematicSvg(clear)).toMatchObject({ status: "pass", scope: "native-ink-clearance-only", completeCoverage: true, collisions: [], unsupported: [] });
    expect(analyzeNativeSchematicSvg(clear).limitations.join(" ")).toContain("Does not establish compactness");
  });

  it("uses actual strokes rather than intersecting text bounding boxes", () => {
    const source = svg(text("A", "M1 1 L1 5 L5 5") + text("B", "M2 2 L4 2 L4 4"));
    expect(analyzeNativeSchematicSvg(source).status).toBe("pass");
  });

  it("inherits stroke widths and recognizes round-cap contacts", () => {
    const source = svg(`<g stroke-width="1">${text("A", "M1 1 L2 1")}<path d="M2.9 1 L3.9 1"/></g>`);
    expect(analyzeNativeSchematicSvg(source)).toMatchObject({ status: "fail", completeCoverage: true });
    expect(analyzeNativeSchematicSvg(source.replace("2.9", "3.1")).status).toBe("pass");
    expect(analyzeNativeSchematicSvg(svg(`${text("A", "M1 1 L2 1")}<path style="stroke-width:2" d="M1 2 L2 2"/>`)).status).toBe("fail");
  });

  it("rejects a nested SVG viewport without assuming root coordinate semantics", () => {
    const result = analyzeNativeSchematicSvg(svg(clear));
    expect(result).toMatchObject({ status: "unknown", completeCoverage: false });
    expect(result.unsupported).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NESTED_SVG_VIEWPORT_UNSUPPORTED" })]));
  });

  it.each([
    { gap: 0.0000005, expectedStatus: "fail" },
    { gap: 0.0000011, expectedStatus: "pass" },
  ])("applies numerical tolerance before broad-phase rejection for ink gap $gap", ({ gap, expectedStatus }) => {
    const y = 1.2 + gap;
    const result = analyzeNativeSchematicSvg(svg(text("A", "M1 1 L2 1") + `<path d="M1 ${y} L2 ${y}"/>`));
    expect(result).toMatchObject({ status: expectedStatus, completeCoverage: true });
    if (expectedStatus === "fail") {
      expect(result.collisions).toHaveLength(1);
      expect(result.collisions[0]!.inkGapMm).toBeGreaterThan(0);
      expect(result.collisions[0]!.inkGapMm).toBeLessThanOrEqual(SCHEMATIC_RENDER_CLEARANCE_POLICY.numericalToleranceMm);
    } else expect(result.collisions).toHaveLength(0);
  });

  it.each([
    ['<path d="M1 1 4 1 4 4 1 4 Z"/>', "M2 1 L3 1"],
    ['<rect x="1" y="1" width="3" height="3" rx="0"/>', "M0.5 2 L2 2"],
    ['<rect x="1" y="1" width="3" height="3" fill="#000000" stroke="none"/>', "M2 2 L3 2"],
    ['<circle cx="3" cy="3" r="1" fill="#000000" stroke="none"/>', "M2.5 3 L3.5 3"],
    ['<circle cx="3" cy="3" r="1"/>', "M1 3 L5 3"],
  ])("supports native primitive %s", (shape, glyph) => {
    expect(analyzeNativeSchematicSvg(svg(text("X", glyph) + shape))).toMatchObject({ status: "fail", completeCoverage: true, unsupported: [] });
  });

  it("distinguishes circle outlines from filled disks", () => {
    const source = svg(text("X", "M2.9 3 L3.1 3") + '<circle cx="3" cy="3" r="1"/>');
    expect(analyzeNativeSchematicSvg(source).status).toBe("pass");
    expect(analyzeNativeSchematicSvg(source.replace('r="1"', 'r="1" fill="black"')).status).toBe("fail");
  });

  it("does not exempt text crossing its own symbol body or a same-symbol field", () => {
    const source = svg(`<g>${text("J1", "M1 1 L3 1")}${text("Value", "M2 0.5 L2 2")}<rect x="1.5" y="0.5" width="1" height="2"/></g>`);
    expect(analyzeNativeSchematicSvg(source).collisions.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["text-text", "text-geometry"]));
  });

  it.each([
    ['<path d="M1 1 C2 2 3 3 4 4"/>', "UNSUPPORTED_PATH_COMMAND"],
    ['<g transform="translate(1 0)"><path d="M1 1 L2 1"/></g>', "UNSUPPORTED_TRANSFORM"],
    ['<path d="M1 1 L2 1" stroke-linecap="square"/>', "UNSUPPORTED_STROKE_CAP_OR_JOIN"],
    ['<path d="M1 1 L2 1" stroke-width="1pt"/>', "UNSUPPORTED_NUMBER_OR_UNIT"],
    ['<path d="M1 1 L2 1" clip-path="url(#clip)"/>', "UNSUPPORTED_ATTRIBUTE"],
    ['<text x="1" y="1">Real font text</text>', "VISIBLE_FONT_TEXT_UNSUPPORTED"],
    ['<use href="external.svg#shape"/>', "UNSUPPORTED_ELEMENT"],
    ['<rect x="1" y="1" width="2" height="2" rx="1"/>', "UNSUPPORTED_RECTANGLE"],
    ['<path d="M1 1 L2 1" style="stroke-dasharray:1 1"/>', "UNSUPPORTED_STYLE"],
    ['<path d="M1 1 L2 1 Z" fill="black"/>', "FILLED_PATH_UNSUPPORTED"],
    ['<rect x="1" y="1" width="2" height="2" fill="white"/>', "UNSUPPORTED_NONBLACK_PAINT_OR_OCCLUSION"],
  ])("marks unsupported geometry unknown: %s", (shape, code) => {
    const result = analyzeNativeSchematicSvg(svg(text("R1", "M20 20 L21 20") + shape));
    expect(result).toMatchObject({ status: "unknown", completeCoverage: false });
    expect(result.unsupported).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it("requires paired native glyph coverage and valid XML without entity expansion", () => {
    for (const source of [svg(""), svg('<text opacity="0">Missing</text>'), clear.replace("<desc>R1</desc>", "<desc>Wrong</desc>"), clear.replace('stroke-width="0.2"', 'stroke-width="0.2" stroke-width="0.3"'), clear.replace("</svg>", "</g>"), `<!DOCTYPE svg [<!ENTITY hidden "ignored">]>${clear}`]) {
      expect(analyzeNativeSchematicSvg(source)).toMatchObject({ status: "unknown", completeCoverage: false });
    }
    expect(analyzeNativeSchematicSvg(svg(text("R&amp;1", "M1 1 L2 1"))).status).toBe("pass");
    expect(analyzeNativeSchematicSvg(clear.replaceAll("R1", "&unresolved;")).status).toBe("unknown");
  });

  it("bounds work and rejects unsupported units without promoting incomplete coverage", () => {
    expect(analyzeNativeSchematicSvg(" ".repeat(SCHEMATIC_RENDER_CLEARANCE_POLICY.maxSvgBytes + 1)).status).toBe("unknown");
    expect(analyzeNativeSchematicSvg(clear.replace('width="100mm"', 'width="100px"')).status).toBe("unknown");
    expect(analyzeNativeSchematicSvg(clear.replace('viewBox="0 0 100 100"', 'viewBox="0 0 50 100"')).status).toBe("unknown");
  });

  it("retains actual text group ordinals when an earlier native group is unsupported", () => {
    const source = svg(text("Broken", "M8 8 L9 8").replace("<desc>Broken</desc>", "<desc>Mismatch</desc>") + text("Later", "M1 1 L2 1") + '<path d="M1.5 0.5 L1.5 2"/>');
    const result = analyzeNativeSchematicSvg(source);
    expect(result).toMatchObject({ status: "fail", completeCoverage: false });
    expect(result.collisions[0]!.a).toMatchObject({ text: "Later", textGroupIndex: 1 });
  });

  it("bounds witness output while still reporting definite collisions", () => {
    const shapes = Array.from({ length: SCHEMATIC_RENDER_CLEARANCE_POLICY.maxWitnesses + 1 }, () => '<path d="M1.5 0.5 L1.5 2"/>').join("");
    const result = analyzeNativeSchematicSvg(svg(text("A", "M1 1 L2 1") + shapes));
    expect(result).toMatchObject({ status: "fail", completeCoverage: true, witnessesTruncated: true });
    expect(result.collisions).toHaveLength(SCHEMATIC_RENDER_CLEARANCE_POLICY.maxWitnesses);
  });

  it("never accepts malformed transforms or XML controls as complete native coverage", () => {
    for (const source of [clear.replace('<g ', '<g transform="matrix(10 0 10 0)" '), clear.replaceAll("R1", "&#1;"), clear.replaceAll("R1", "\u0000"), clear.replace('<g ', '<g id="bad<xml" '), clear.replace('http://www.w3.org/2000/svg', 'urn:not-svg'), clear.replace('<desc>R1</desc>', '<desc>R1<path d="M1 1 L2 1"/></desc>')]) {
      expect(analyzeNativeSchematicSvg(source)).toMatchObject({ status: "unknown", completeCoverage: false });
    }
    expect(analyzeNativeSchematicSvg(clear.replace('<g ', '<g transform="matrix(1 0 0 1 0 0)" ')).status).toBe("pass");
  });

  it("marks viewport clipping and exhausted collision work unknown or incomplete", () => {
    expect(analyzeNativeSchematicSvg(svg(text("Outside", "M101 1 L102 1")))).toMatchObject({ status: "unknown", completeCoverage: false, unsupported: [expect.objectContaining({ code: "INK_OUTSIDE_NATIVE_VIEWPORT" })] });
    const strokes = Array.from({ length: 11 }, (_, index) => `${index === 0 ? "M" : "L"}${index + 1} 1`).join(" ");
    const crowded = svg(Array.from({ length: 201 }, (_, index) => text(`R${index}`, strokes)).join(""));
    const result = analyzeNativeSchematicSvg(crowded);
    expect(result).toMatchObject({ status: "fail", completeCoverage: false, witnessesTruncated: true });
    expect(result.unsupported).toEqual(expect.arrayContaining([expect.objectContaining({ code: "COLLISION_WORK_LIMIT" })]));
  });

  it("binds exact SVG bytes, sources, executable, invocation, policy, and validation pass", () => {
    const native = capture(); const evidence = createSchematicRenderClearanceEvidence(native, expected);
    expect(evidence).toMatchObject({ status: "pass", bindingProblems: [], nativeSvgIdentity: contentIdentity(native.source), sources });
    expect(verifyHostSchematicRenderClearanceEvidence(evidence, expected)).toBe(evidence);
    const persisted = JSON.parse(JSON.stringify(evidence));
    expect(() => verifyHostSchematicRenderClearanceEvidence(persisted, expected)).toThrow(/current host/);
    const verified = verifySchematicRenderClearanceEvidence(persisted, native, expected);
    expect(canonicalJson(verified)).toBe(canonicalJson(evidence));
    expect(verifyHostSchematicRenderClearanceEvidence(verified, expected)).toBe(verified);
    expect(Object.isFrozen(evidence.collisions)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("C:/private");
    expect(() => verifySchematicRenderClearanceEvidence({ ...persisted, status: "unknown" }, native, expected)).toThrow(/does not reproduce/);
  });

  it.each(["schematic", "pcb", "projectSettings"] as const)("keeps stale %s evidence unknown and rejects reuse against changed sources", (key) => {
    const changed = { ...expected, sources: { ...sources, [key]: contentIdentity("changed") } };
    expect(createSchematicRenderClearanceEvidence(capture(), changed)).toMatchObject({ status: "unknown", completeCoverage: false, bindingProblems: ["STALE_SOURCE_IDENTITIES"] });
    expect(() => verifyHostSchematicRenderClearanceEvidence(createSchematicRenderClearanceEvidence(capture(), expected), changed)).toThrow(/current sources/);
  });

  it("rejects artifact/tool/validation drift and does not authenticate reminted plain objects", () => {
    const native = capture(); const evidence = createSchematicRenderClearanceEvidence(native, expected);
    expect(createSchematicRenderClearanceEvidence({ ...native, source: native.source + "\n" }, expected)).toMatchObject({ status: "unknown", bindingProblems: ["SVG_ARTIFACT_IDENTITY_MISMATCH"] });
    expect(createSchematicRenderClearanceEvidence(native, { ...expected, executable: { ...executable, sha256: "c".repeat(64) } })).toMatchObject({ status: "unknown", bindingProblems: ["EXECUTABLE_IDENTITY_MISMATCH"] });
    expect(createSchematicRenderClearanceEvidence({ ...native, invocation: { ...native.invocation, exitCode: 1 } }, expected).status).toBe("unknown");
    const changedPass = { ...expected, validationSourceBindingIdentity: canonicalIdentity({ next: true }, "evleda.pcb-harness-validation-source-binding.v1") };
    expect(() => verifyHostSchematicRenderClearanceEvidence(evidence, changedPass)).toThrow(/validation pass/);
    expect(() => verifyHostSchematicRenderClearanceEvidence({ ...evidence }, expected)).toThrow(/current host/);
  });
});

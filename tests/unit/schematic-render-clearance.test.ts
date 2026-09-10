import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { KicadSchematicSvgResult } from "../../src/integrations/kicad-cli.js";
import {
  analyzeNativeSchematicSvg, createSchematicRenderClearanceEvidence, verifySchematicRenderClearanceEvidence,
  verifyHostSchematicRenderClearanceEvidence, SCHEMATIC_RENDER_CLEARANCE_POLICY, type SchematicRenderClearanceExpected,
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

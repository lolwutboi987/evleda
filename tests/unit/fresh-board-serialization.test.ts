import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FreshBoardSerializationError,
  FRESH_BOARD_SERIALIZATION_LIMITS,
  freshBoardComparisonText,
  freshBoardSerializationsEqual,
} from "../../src/harness/fresh-board-serialization.js";

// Captured native KiCad 10.0.3 API source, not a new native execution.
// D:/EvlEDA-authored-netclass-sync-probe-20260908-02/result.json
// rawToolCalls[request.name=pcb_get_board_as_string].result.structuredContent.result
// result.json SHA256: 9d2da2429c9d0d4ee9d89b5d6113126627022ef649b9c32c1c05e6d2f08918d2
// The reconstructed CRLF form below is independently pinned to the captured
// compilation/project/authored-netclass-divider.kicad_pcb raw hash and size.
const CAPTURED_LIVE_SOURCE = Buffer.from(
  "KGtpY2FkX3BjYgoJKHZlcnNpb24gMjAyNjAyMDYpCgkoZ2VuZXJhdG9yICJwY2JuZXciKQoJKGdlbmVyYXRvcl92ZXJzaW9uICIxMC4wIikKCShnZW5lcmFsCgkJKHRoaWNrbmVzcyAxLjYpCgkJKGxlZ2FjeV90ZWFyZHJvcHMgbm8pCgkpCgkocGFwZXIgIkE0IikKCShsYXllcnMKCQkoMCAiRi5DdSIgc2lnbmFsKQoJCSgyICJCLkN1IiBzaWduYWwpCgkJKDI1ICJFZGdlLkN1dHMiIHVzZXIpCgkJKDI3ICJNYXJnaW4iIHVzZXIpCgkJKDMxICJGLkNydFlkIiB1c2VyICJGLkNvdXJ0eWFyZCIpCgkJKDI5ICJCLkNydFlkIiB1c2VyICJCLkNvdXJ0eWFyZCIpCgkpCgkoc2V0dXAKCQkocGFkX3RvX21hc2tfY2xlYXJhbmNlIDApCgkJKGFsbG93X3NvbGRlcm1hc2tfYnJpZGdlc19pbl9mb290cHJpbnRzIG5vKQoJCSh0ZW50aW5nCgkJCShmcm9udCB5ZXMpCgkJCShiYWNrIHllcykKCQkpCgkJKGNvdmVyaW5nCgkJCShmcm9udCBubykKCQkJKGJhY2sgbm8pCgkJKQoJCShwbHVnZ2luZwoJCQkoZnJvbnQgbm8pCgkJCShiYWNrIG5vKQoJCSkKCQkoY2FwcGluZyBubykKCQkoZmlsbGluZyBubykKCQkocGNicGxvdHBhcmFtcwoJCQkobGF5ZXJzZWxlY3Rpb24gMHgwMDAwMDAwMF8wMDAwMDAwMF81NTU1NTU1NV81NzU1ZjVmZikKCQkJKHBsb3Rfb25fYWxsX2xheWVyc19zZWxlY3Rpb24gMHgwMDAwMDAwMF8wMDAwMDAwMF8wMDAwMDAwMF8wMDAwMDAwMCkKCQkJKGRpc2FibGVhcGVydG1hY3JvcyBubykKCQkJKHVzZWdlcmJlcmV4dGVuc2lvbnMgbm8pCgkJCSh1c2VnZXJiZXJhdHRyaWJ1dGVzIHllcykKCQkJKHVzZWdlcmJlcmFkdmFuY2VkYXR0cmlidXRlcyB5ZXMpCgkJCShjcmVhdGVnZXJiZXJqb2JmaWxlIHllcykKCQkJKGRhc2hlZF9saW5lX2Rhc2hfcmF0aW8gMTIpCgkJCShkYXNoZWRfbGluZV9nYXBfcmF0aW8gMykKCQkJKHN2Z3ByZWNpc2lvbiA0KQoJCQkocGxvdGZyYW1lcmVmIG5vKQoJCQkobW9kZSAxKQoJCQkodXNlYXV4b3JpZ2luIG5vKQoJCQkocGRmX2Zyb250X2ZwX3Byb3BlcnR5X3BvcHVwcyB5ZXMpCgkJCShwZGZfYmFja19mcF9wcm9wZXJ0eV9wb3B1cHMgeWVzKQoJCQkocGRmX21ldGFkYXRhIHllcykKCQkJKHBkZl9zaW5nbGVfZG9jdW1lbnQgbm8pCgkJCShkeGZwb2x5Z29ubW9kZSB5ZXMpCgkJCShkeGZpbXBlcmlhbHVuaXRzIHllcykKCQkJKGR4ZnVzZXBjYm5ld2ZvbnQgeWVzKQoJCQkocHNuZWdhdGl2ZSBubykKCQkJKHBzYTRvdXRwdXQgbm8pCgkJCShwbG90X2JsYWNrX2FuZF93aGl0ZSB5ZXMpCgkJCShza2V0Y2hwYWRzb25mYWIgbm8pCgkJCShwbG90cGFkbnVtYmVycyBubykKCQkJKGhpZGVkbnBvbmZhYiBubykKCQkJKHNrZXRjaGRucG9uZmFiIHllcykKCQkJKGNyb3Nzb3V0ZG5wb25mYWIgeWVzKQoJCQkoc3VidHJhY3RtYXNrZnJvbXNpbGsgbm8pCgkJCShvdXRwdXRmb3JtYXQgMSkKCQkJKG1pcnJvciBubykKCQkJKGRyaWxsc2hhcGUgMSkKCQkJKHNjYWxlc2VsZWN0aW9uIDEpCgkJCShvdXRwdXRkaXJlY3RvcnkgIiIpCgkJKQoJKQoJKGVtYmVkZGVkX2ZvbnRzIG5vKQopCg==",
  "base64",
).toString("utf8");
const sha256 = (source: string) => createHash("sha256").update(source, "utf8").digest("hex");

const BOARD = '(kicad_pcb\n\t(version 20260206)\n\t(net 1 "VIN")\n\t(property "Value" "10k")\n\t(segment (start 1 2) (end 3 4) (width 0.25) (layer "F.Cu") (net 1))\n)\n';
const FOOTPRINT_HEADER = '(version 20260206) (generator "pcbnew") (generator_version "10.0")';
const footprintBoard = (prefix = "", suffix = "") =>
  `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0") (footprint "Example" ${prefix} (layer "F.Cu") ${suffix}))\n`;
const capturedPair = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/authored-netclass-sync05-board-serialization.json", import.meta.url), "utf8")) as {
  nativeExecutionByTests: boolean;
  disk: { base64: string; contentIdentity: { digest: string; size: number } };
  live: { base64: string; contentIdentity: { digest: string; size: number } };
  nativeSourceFacts: { file: string; url: string; contentIdentity: { digest: string }; excerpts: { text: string }[] }[];
};
const CAPTURED_POPULATED_DISK = Buffer.from(capturedPair.disk.base64, "base64").toString("utf8");
const CAPTURED_POPULATED_LIVE = Buffer.from(capturedPair.live.base64, "base64").toString("utf8");
const reopenedPair = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/reopened-rotated-board-serialization.json", import.meta.url), "utf8")) as {
  nativeExecutionByTests: boolean; disk: string; live: string;
};

describe("fresh board complete lexical serialization comparison", () => {
  it("matches the captured reopened rotated board without changing either raw source identity", () => {
    const disk = Buffer.from(reopenedPair.disk, "base64").toString("utf8");
    const live = Buffer.from(reopenedPair.live, "base64").toString("utf8");
    expect(reopenedPair.nativeExecutionByTests).toBe(false);
    expect(Buffer.byteLength(disk)).toBe(13307);
    expect(Buffer.byteLength(live)).toBe(12394);
    expect(sha256(disk)).toBe("1a7eb97c782512a997f99e2226656b72ae1fbdf736961ac80b292a9b66ff1d82");
    expect(sha256(live)).toBe("33ebd7862d713fc9f7d5324d8bc2371862e00d00e3c7f258351318656719f851");
    expect(freshBoardSerializationsEqual(disk, live)).toBe(true);
    expect(freshBoardSerializationsEqual(live, disk)).toBe(true);
    expect(disk).not.toBe(live);
  });

  it.each(["property", "pad"])("permits only exact -90/270 in direct footprint %s at angles", kind => {
    const prefix = kind === "property" ? '"Reference" "R1"' : '"1" smd rect';
    const make = (angle: string, x = "1") => footprintBoard("", `(${kind} ${prefix} (at ${x} 2 ${angle}))`);
    expect(freshBoardSerializationsEqual(make("-90"), make("270"))).toBe(true);
    expect(freshBoardSerializationsEqual(make("270"), make("-90"))).toBe(true);
    for (const angle of ["90", "269.999", "-90.0", "270.0", "630", '"270"', "-450"]) {
      expect(freshBoardSerializationsEqual(make("-90"), make(angle))).toBe(false);
    }
    expect(freshBoardSerializationsEqual(make("-90"), make("270", "1.0"))).toBe(false);
    expect(freshBoardSerializationsEqual(make("-90", "-90"), make("270", "270"))).toBe(false);
  });

  it.each([
    '(at 1 2 ANGLE)',
    '(fp_text user "R1" (at 1 2 ANGLE))',
    '(unknown (at 1 2 ANGLE))',
    '(property "a" "b" (nested (at 1 2 ANGLE)))',
    '(property "a" "b" (at 1 2 ANGLE 4))',
    '(property "a" "b" (at 1 2 ANGLE (unknown 1)))',
    '(property "a" "b" (at 1 ANGLE))',
  ])("keeps other footprint angle contexts exact: %s", form => {
    expect(freshBoardSerializationsEqual(footprintBoard("", form.replace("ANGLE", "-90")),
      footprintBoard("", form.replace("ANGLE", "270")))).toBe(false);
  });

  it("does not alias root, nested footprint, or coordinate angles", () => {
    for (const form of [
      '(kicad_pcb (property "a" "b" (at 1 2 ANGLE)))\n',
      '(kicad_pcb (pad "1" smd rect (at 1 2 ANGLE)))\n',
      '(kicad_pcb (unknown (footprint "nested" (property "a" "b" (at 1 2 ANGLE)))))\n',
    ]) expect(freshBoardSerializationsEqual(form.replace("ANGLE", "-90"), form.replace("ANGLE", "270"))).toBe(false);
  });

  it("matches the captured LF API source and CRLF disk source while retaining their different raw hashes", () => {
    const capturedDisk = CAPTURED_LIVE_SOURCE.replaceAll("\n", "\r\n");
    expect(Buffer.byteLength(CAPTURED_LIVE_SOURCE)).toBe(1537);
    expect(sha256(CAPTURED_LIVE_SOURCE)).toBe("dda2c1cf5bd722fc14c3e6acc32626eb5dbe26c35d2635fa416ae9f832521ec7");
    expect(Buffer.byteLength(capturedDisk)).toBe(1610);
    expect(sha256(capturedDisk)).toBe("893efea3b13b859ee6540594844e6390530098c302ce80874ccbc5846c94bdda");
    expect(capturedDisk.match(/\r\n/gu)).toHaveLength(73);
    expect(freshBoardSerializationsEqual(CAPTURED_LIVE_SOURCE, capturedDisk)).toBe(true);
    expect(freshBoardSerializationsEqual(capturedDisk, CAPTURED_LIVE_SOURCE)).toBe(true);
    expect(freshBoardComparisonText(capturedDisk)).toBe(CAPTURED_LIVE_SOURCE);
    expect(freshBoardComparisonText(capturedDisk).endsWith(")\n")).toBe(true);
    expect(sha256(capturedDisk)).not.toBe(sha256(freshBoardComparisonText(capturedDisk)));
  });

  it("permits physical LF and CRLF delimiters without requiring one style throughout the source", () => {
    const mixed = BOARD.replace("\n", "\r\n");
    expect(freshBoardSerializationsEqual(BOARD, BOARD)).toBe(true);
    expect(freshBoardSerializationsEqual(BOARD, mixed)).toBe(true);
    expect(freshBoardComparisonText(freshBoardComparisonText(mixed))).toBe(BOARD);
  });

  it("permits native ASCII layout whitespace while retaining the deliberate EOF whitespace boundary", () => {
    for (const equivalent of [BOARD.replace("\t(version", "  (version"), BOARD.replace("(net 1", "(net  1"), `\n\t ${BOARD}`,
      BOARD.replace("(width 0.25)", "(width\n\t0.25)"), BOARD.replaceAll("\n", " ").trimEnd() + "\n"]) {
      expect(freshBoardSerializationsEqual(BOARD, equivalent)).toBe(true);
    }
    expect(freshBoardSerializationsEqual(BOARD, `${BOARD} `)).toBe(false);
  });

  it.each([
    ["geometry", BOARD.replace("(start 1 2)", "(start 1 2.01)")],
    ["net", BOARD.replace('"VIN"', '"VOUT"')],
    ["value", BOARD.replace('"10k"', '"12k"')],
    ["equivalent numeric spelling", BOARD.replace("(width 0.25)", "(width 0.250)")],
    ["extra form", BOARD.replace("\n)\n", "\n\t(embedded_fonts no)\n)\n")],
    ["missing form", BOARD.replace('\t(property "Value" "10k")\n', "")],
    ["form order", BOARD.replace('\t(net 1 "VIN")\n\t(property "Value" "10k")', '\t(property "Value" "10k")\n\t(net 1 "VIN")')],
    ["removed final newline", BOARD.slice(0, -1)],
    ["extra final newline", `${BOARD}\n`],
  ])("does not accept %s changes", (_name, changed) => {
    expect(freshBoardSerializationsEqual(BOARD, changed!.replaceAll("\n", "\r\n"))).toBe(false);
  });

  it("preserves quoted escape sequences, escaped quotes, literal backslashes, and Unicode", () => {
    const source = String.raw`(kicad_pcb (property "Value" "line\nnext\rreturn\\path\"quoted café Ω 😀"))` + "\n";
    expect(freshBoardComparisonText(source.replaceAll("\n", "\r\n"))).toBe(source);
    expect(freshBoardSerializationsEqual(source, source.replace(String.raw`\n`, String.raw`\r\n`))).toBe(false);
    expect(freshBoardSerializationsEqual(source, source.replace(String.raw`\\path`, String.raw`\path`))).toBe(false);
  });

  it.each([
    ["bare CR", "(kicad_pcb\r)", "BARE_CARRIAGE_RETURN"],
    ["terminal CR", "(kicad_pcb)\r", "BARE_CARRIAGE_RETURN"],
    ["CRCRLF", "(kicad_pcb\r\r\n)", "BARE_CARRIAGE_RETURN"],
    ["LFCR", "(kicad_pcb\n\r)", "BARE_CARRIAGE_RETURN"],
    ["literal quoted LF", '(kicad_pcb (property "Value" "a\nb"))', "PHYSICAL_NEWLINE_IN_STRING"],
    ["literal quoted CRLF", '(kicad_pcb (property "Value" "a\r\nb"))', "PHYSICAL_NEWLINE_IN_STRING"],
    ["literal quoted CR", '(kicad_pcb (property "Value" "a\rb"))', "PHYSICAL_NEWLINE_IN_STRING"],
    ["backslash physical newline", '(kicad_pcb (property "Value" "a\\\nb"))', "PHYSICAL_NEWLINE_IN_STRING"],
    ["unterminated quote", '(kicad_pcb (property "Value" "abc)', "UNTERMINATED_STRING"],
    ["dangling escape", '(kicad_pcb (property "Value" "abc\\', "UNTERMINATED_STRING"],
    ["lone surrogate", "(kicad_pcb \ud800)", "INVALID_TEXT"],
    ["BOM", `\uFEFF${BOARD}`, "INVALID_TEXT"],
    ["embedded BOM outside strings", BOARD.replace("(net 1", "(net\uFEFF1"), "INVALID_TEXT"],
    ["non-ASCII separator", BOARD.replace("(net 1", "(net\u00a01"), "INVALID_TEXT"],
    ["form-feed separator", BOARD.replace("(net 1", "(net\f1"), "INVALID_TEXT"],
    ["NUL", BOARD.replace('"10k"', '"10\0k"'), "INVALID_TEXT"],
  ])("rejects unsupported %s even when both sources are identical", (_name, source, code) => {
    expect(() => freshBoardComparisonText(source!)).toThrow(FreshBoardSerializationError);
    expect(() => freshBoardComparisonText(source!)).toThrow(expect.objectContaining({ code }));
    expect(() => freshBoardSerializationsEqual(source!, source!)).toThrow(FreshBoardSerializationError);
  });

  it("matches the entire immutable populated native pair and independently preserves both raw source hashes", () => {
    expect(capturedPair.nativeExecutionByTests).toBe(false);
    expect(Buffer.byteLength(CAPTURED_POPULATED_DISK)).toBe(12430);
    expect(Buffer.byteLength(CAPTURED_POPULATED_LIVE)).toBe(11496);
    expect(sha256(CAPTURED_POPULATED_DISK)).toBe("0facbb6524a43568296d513d4809a2d34f8204ab92572c34bf68a64df22e8181");
    expect(sha256(CAPTURED_POPULATED_LIVE)).toBe("cef3f8f4d49bf29a5d382ae69f90b3270558c4db15997db86fdfcf3ee6012759");
    expect(freshBoardComparisonText(CAPTURED_POPULATED_DISK)).not.toBe(CAPTURED_POPULATED_LIVE);
    expect(freshBoardSerializationsEqual(CAPTURED_POPULATED_DISK, CAPTURED_POPULATED_LIVE)).toBe(true);
    expect(freshBoardSerializationsEqual(CAPTURED_POPULATED_LIVE, CAPTURED_POPULATED_DISK)).toBe(true);
    expect(sha256(CAPTURED_POPULATED_DISK)).toBe(capturedPair.disk.contentIdentity.digest);
    expect(sha256(CAPTURED_POPULATED_LIVE)).toBe(capturedPair.live.contentIdentity.digest);
  });

  it("records the independent pinned native predicates behind metadata and formatting differences", () => {
    const source = (name: string) => capturedPair.nativeSourceFacts.find((entry) => entry.file === name)!;
    const header = source("pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h").excerpts.map((entry) => entry.text).join("\n");
    expect(header).toMatch(/#define SEXPR_BOARD_FILE_VERSION\s+20260206/u);
    expect(header).toMatch(/#define CTL_FOR_BOARD\s+\(CTL_OMIT_INITIAL_COMMENTS\|CTL_OMIT_FOOTPRINT_VERSION\)/u);
    expect(header).toMatch(/#define CTL_FOR_CLIPBOARD\s+\(CTL_OMIT_INITIAL_COMMENTS\)/u);
    const emitter = source("pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp").excerpts.map((entry) => entry.text).join("\n");
    expect(emitter).toContain("if( !( m_ctl & CTL_OMIT_FOOTPRINT_VERSION ) )");
    expect(emitter).toContain("SEXPR_BOARD_FILE_VERSION,");
    expect(emitter).toContain("GetMajorMinorVersion()");
    expect(emitter).toContain("PRETTIFIED_FILE_OUTPUTFORMATTER formatter( aFileName )");
    const pretty = source("common/io/kicad/kicad_io_utils.cpp").excerpts.map((entry) => entry.text).join("\n");
    expect(pretty).toContain("aMode == FORMAT_MODE::COMPACT_TEXT_PROPERTIES");
    expect(pretty).toContain("aChar == ' ' || aChar == '\\t' || aChar == '\\n' || aChar == '\\r'");
    for (const kind of ["font", "stroke", "fill", "teardrop", "offset", "rotate", "scale"]) expect(pretty).toContain(`token == "${kind}"`);
    for (const fact of capturedPair.nativeSourceFacts) {
      expect(fact.url).toBe(`https://raw.githubusercontent.com/KiCad/kicad-source-mirror/10.0.3/${fact.file}`);
      expect(fact.contentIdentity.digest).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it.each([
    ["pad number", '(pad "1"', '(pad "9"'],
    ["pad net", '(net "VOUT")', '(net "VIN")'],
    ["pad geometry", "(size 0.8 0.95)", "(size 0.8 0.96)"],
    ["placement", "(at 23 70)", "(at 23 70.001)"],
    ["line width", "(width 0.12)", "(width 0.13)"],
    ["numeric spelling", "(width 0.12)", "(width 0.120)"],
    ["footprint UUID", "5e7a1cb5-9f67-4d9e-b4dc-2482c0b80fa9", "00000000-9f67-4d9e-b4dc-2482c0b80fa9"],
    ["model path", "${KICAD10_3DMODEL_DIR}/Resistor_SMD", "${KICAD10_3DMODEL_DIR}/Other"],
    ["quoted whitespace", "Resistor SMD 0603", "Resistor  SMD 0603"],
    ["value", '(property "Value" "10k"', '(property "Value" "11k"'],
    ["root version", "\t(version 20260206)", "\t(version 20250316)"],
    ["root generator", '\t(generator "pcbnew")', '\t(generator "other")'],
    ["root generator version", '\t(generator_version "10.0")', '\t(generator_version "10.1")'],
    ["extra unknown form", "\t(embedded_fonts no)\n)\n", "\t(unknown_metadata 1)\n\t(embedded_fonts no)\n)\n"],
  ])("rejects %s changes in the full captured board", (_label, before, after) => {
    expect(CAPTURED_POPULATED_LIVE).toContain(before!);
    const changed = CAPTURED_POPULATED_LIVE.replace(before!, after!);
    expect(freshBoardSerializationsEqual(CAPTURED_POPULATED_DISK, changed)).toBe(false);
  });

  it("allows only the complete pinned footprint header and keeps nested/user fields exact", () => {
    expect(freshBoardSerializationsEqual(footprintBoard(), footprintBoard(FOOTPRINT_HEADER))).toBe(true);
    expect(freshBoardSerializationsEqual(footprintBoard(FOOTPRINT_HEADER), footprintBoard(FOOTPRINT_HEADER))).toBe(true);
    const nested = '(property "Generator" "user value" (version 1) (generator "user") (generator_version "2"))';
    expect(freshBoardSerializationsEqual(footprintBoard("", nested), footprintBoard(FOOTPRINT_HEADER, nested))).toBe(true);
    expect(freshBoardSerializationsEqual(footprintBoard("", nested), footprintBoard(FOOTPRINT_HEADER, nested.replace('"user"', '"changed"')))).toBe(false);
    // A triplet inside user/nested content is never mistaken for direct emitted metadata.
    expect(freshBoardSerializationsEqual(footprintBoard(), footprintBoard("", `(property "Text" "value" ${FOOTPRINT_HEADER})`))).toBe(false);
  });

  it.each([
    ["altered version", FOOTPRINT_HEADER.replace("20260206", "20250316"), ""],
    ["altered generator", FOOTPRINT_HEADER.replace('"pcbnew"', '"other"'), ""],
    ["altered generator version", FOOTPRINT_HEADER.replace('"10.0"', '"10.0.3"'), ""],
    ["unquoted generator", FOOTPRINT_HEADER.replace('"pcbnew"', "pcbnew"), ""],
    ["partial tuple", '(version 20260206) (generator "pcbnew")', ""],
    ["missing first field", '(generator "pcbnew") (generator_version "10.0")', ""],
    ["duplicate tuple", `${FOOTPRINT_HEADER} ${FOOTPRINT_HEADER}`, ""],
    ["duplicate field", `(version 20260206) ${FOOTPRINT_HEADER}`, ""],
    ["misplaced tuple", "", FOOTPRINT_HEADER],
    ["interleaved form", FOOTPRINT_HEADER.replace('(generator "pcbnew")', '(locked yes) (generator "pcbnew")'), ""],
    ["extra version atom", FOOTPRINT_HEADER.replace("(version 20260206)", "(version 20260206 1)"), ""],
    ["nested metadata field", FOOTPRINT_HEADER.replace("(version 20260206)", "(version 20260206 (extra 1))"), ""],
    ["unquoted footprint name", FOOTPRINT_HEADER, ""],
  ])("rejects %s even if the same malformed tuple appears in both sources", (label, prefix, suffix) => {
    let source = footprintBoard(prefix, suffix);
    if (label === "unquoted footprint name") source = source.replace('"Example"', "Example");
    expect(() => freshBoardSerializationsEqual(source, source)).toThrow(expect.objectContaining({ code: "INVALID_FOOTPRINT_HEADER" }));
  });

  it("does not infer footprint version from matching PCB root versions", () => {
    const source = footprintBoard(FOOTPRINT_HEADER).replaceAll("20260206", "20250316");
    expect(() => freshBoardSerializationsEqual(source, source)).toThrow(expect.objectContaining({ code: "INVALID_FOOTPRINT_HEADER" }));
  });

  it.each(["", " ", "()", "(other)", "(kicad_pcb", "(kicad_pcb))", "(kicad_pcb)(kicad_pcb)",
    "outside (kicad_pcb)", "(kicad_pcb) outside", "(kicad_pcb atom)", '("kicad_pcb")',
    '(kicad_pcb ((field 1)))', '(kicad_pcb (property "a""b"))', '(kicad_pcb (value abc"def"))',
  ])("rejects malformed whole-source syntax: %j", (source) => {
    expect(() => freshBoardSerializationsEqual(source, source)).toThrow(expect.objectContaining({ code: "MALFORMED_SOURCE" }));
  });

  it("bounds source size, token size, token count, and nesting without recursive parsing", () => {
    const limits = FRESH_BOARD_SERIALIZATION_LIMITS;
    expect(() => freshBoardComparisonText("a".repeat(limits.maximumSourceBytes + 1))).toThrow(expect.objectContaining({ code: "SOURCE_TOO_LARGE" }));
    const longToken = `(kicad_pcb (data "${"a".repeat(limits.maximumTokenCharacters)}"))`;
    expect(() => freshBoardSerializationsEqual(longToken, longToken)).toThrow(expect.objectContaining({ code: "TOKEN_TOO_LARGE" }));
    const deep = `(kicad_pcb ${"(n ".repeat(limits.maximumDepth)}x${")".repeat(limits.maximumDepth)})`;
    expect(() => freshBoardSerializationsEqual(deep, deep)).toThrow(expect.objectContaining({ code: "EXCESSIVE_DEPTH" }));
    const many = `(kicad_pcb (data ${"a ".repeat(limits.maximumTokens)}))`;
    expect(() => freshBoardSerializationsEqual(many, many)).toThrow(expect.objectContaining({ code: "TOO_MANY_TOKENS" }));
  });
});

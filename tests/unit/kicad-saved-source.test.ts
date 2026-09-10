import { writeFileSync } from "node:fs";
import { link, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { parseFreshPcbReferenceGeometry } from "../../src/harness/fresh-kicad-parser.js";
import { createKicadSavedSourceReader, KICAD_SAVED_SOURCE_MAX_BYTES } from "../../src/integrations/kicad-saved-source.js";
import { createKicadStackupReader } from "../../src/integrations/kicad-stackup.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const source = '(kicad_pcb\r\n (version 20260206) (layers (0 "F.Cu" signal) (2 "B.Cu" signal))\r\n (general (thickness 1.6)) (property "label" "Café") (setup))\r\n';

async function fixture(bytes: Buffer | string = source) {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-saved-source-")); roots.push(root);
  const pcbPath = path.join(root, "board.kicad_pcb"); await writeFile(pcbPath, bytes);
  return { pcbPath, observe: await createKicadSavedSourceReader({ pcbPath }) };
}

describe("bounded saved PCB source observation", () => {
  it("calls a synchronous parser once and keeps raw file identity separate from its value", async () => {
    const f = await fixture(); const parse = vi.fn(text => ({ length: text.length }));
    const result = await f.observe(parse);
    expect(parse).toHaveBeenCalledExactlyOnceWith(source);
    expect(result).toEqual({ value: { length: source.length }, sourceIdentity: contentIdentity(Buffer.from(source)) });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.sourceIdentity)).toBe(true);
  });

  it("preserves BOM, CRLF and Unicode so source-based parser identity equals raw-byte identity", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)]);
    const f = await fixture(bytes);
    const observed = await f.observe(text => ({ text, parsed: parseFreshPcbReferenceGeometry(text) }));
    expect(observed.value.text).toBe("\uFEFF" + source);
    expect(Buffer.from(observed.value.text, "utf8")).toEqual(bytes);
    expect(observed.sourceIdentity).toEqual(contentIdentity(bytes));
    expect(observed.value.parsed.sourceIdentity).toEqual(observed.sourceIdentity);
    const stackup = await (await createKicadStackupReader({ pcbPath: f.pcbPath }))();
    expect(stackup.sourceIdentity).toEqual(observed.sourceIdentity);
    expect(stackup.stackup).toMatchObject({ status: "missing", generalBoardThicknessMm: { value: 1.6 } });
  });

  it("detects a file mutation made during synchronous parsing", async () => {
    const f = await fixture();
    await expect(f.observe(text => { writeFileSync(f.pcbPath, source.replace("1.6", "1.7")); return text; }))
      .rejects.toThrow("changed during observation");
  });

  it("propagates parser failure and can observe the same ordinary file afterward", async () => {
    const f = await fixture();
    await expect(f.observe(() => { throw new Error("parser rejected source"); })).rejects.toThrow("parser rejected source");
    expect((await f.observe(text => text)).value).toBe(source);
  });

  it("rejects asynchronous parser results and thenables instead of publishing unbracketed work", async () => {
    const f = await fixture();
    await expect(f.observe(() => Promise.resolve("later"))).rejects.toThrow("synchronous parser");
    await expect(f.observe(() => Promise.reject(new Error("rejected later")))).rejects.toThrow("synchronous parser");
    const then = vi.fn(); await expect(f.observe(() => ({ then }))).rejects.toThrow("synchronous parser");
    expect(then).not.toHaveBeenCalled();
  });

  it("observes new saved revisions without reusing old bytes or identity", async () => {
    const f = await fixture(); const first = await f.observe(text => text);
    const next = source.replace("Café", "New board"); await writeFile(f.pcbPath, next);
    const second = await f.observe(text => text);
    expect(second.value).toBe(next); expect(second.sourceIdentity).toEqual(contentIdentity(Buffer.from(next)));
    expect(second.sourceIdentity).not.toEqual(first.sourceIdentity);
  });

  it("retains ordinary-path, hard-link, UTF-8 and size bounds", async () => {
    await expect(createKicadSavedSourceReader({ pcbPath: "board.kicad_pcb" })).rejects.toThrow("absolute");
    const f = await fixture(); await link(f.pcbPath, path.join(path.dirname(f.pcbPath), "alias.kicad_pcb"));
    await expect(f.observe(text => text)).rejects.toThrow("ordinary");
    const invalid = await fixture(Buffer.from([0xff])); const parse = vi.fn();
    await expect(invalid.observe(parse)).rejects.toThrow(); expect(parse).not.toHaveBeenCalled();
    const large = await fixture(); await truncate(large.pcbPath, KICAD_SAVED_SOURCE_MAX_BYTES + 1);
    await expect(large.observe(text => text)).rejects.toThrow("bounded read");
  });
});

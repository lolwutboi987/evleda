import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parsePeVersionInfo } from "../../src/flux/pe-version-info.js";

const align4 = (value: number): number => (value + 3) & ~3;
const utf16z = (value: string): Buffer => Buffer.from(`${value}\0`, "utf16le");

const versionWords = (value: readonly [number, number, number, number]): readonly [number, number] => [
  (value[0] << 16) | value[1],
  (value[2] << 16) | value[3],
];

const block = (key: string, type: 0 | 1, value: Buffer, valueLength: number, children: readonly Buffer[] = []): Buffer => {
  const keyBytes = utf16z(key);
  const valueOffset = align4(6 + keyBytes.length);
  const paddedChildren = children.flatMap((child) => [child, Buffer.alloc(align4(child.length) - child.length)]);
  const body = Buffer.concat([Buffer.alloc(valueOffset), value, Buffer.alloc(align4(valueOffset + value.length) - valueOffset - value.length), ...paddedChildren]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(valueLength, 2);
  body.writeUInt16LE(type, 4);
  keyBytes.copy(body, 6);
  return body;
};

const stringBlock = (key: string, value: string): Buffer => {
  const bytes = utf16z(value);
  return block(key, 1, bytes, bytes.length / 2);
};

const versionResource = (): Buffer => {
  const [fileMost, fileLeast] = versionWords([10, 0, 3, 49_839]);
  const [productMost, productLeast] = versionWords([10, 0, 3, 49_839]);
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(fileMost, 8); fixed.writeUInt32LE(fileLeast, 12);
  fixed.writeUInt32LE(productMost, 16); fixed.writeUInt32LE(productLeast, 20);
  const strings = block("040904b0", 1, Buffer.alloc(0), 0, [
    stringBlock("FileVersion", "10.0.3.49839"),
    stringBlock("ProductVersion", "10.0.3"),
    stringBlock("OriginalFilename", "pcbnew.exe"),
    stringBlock("InternalName", "pcbnew"),
  ]);
  return block("VS_VERSION_INFO", 0, fixed, fixed.length, [block("StringFileInfo", 1, Buffer.alloc(0), 0, [strings])]);
};

const syntheticPe = (): Readonly<{ readonly bytes: Buffer; readonly rootOffset: number; readonly dataEntryOffset: number }> => {
  const bytes = Buffer.alloc(0x2000);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1000, optional + 112 + 16);
  bytes.writeUInt32LE(0x1000, optional + 112 + 20);
  const section = optional + 0xf0;
  bytes.write(".rsrc\0\0\0", section, "ascii");
  bytes.writeUInt32LE(0x1000, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x1000, section + 16);
  bytes.writeUInt32LE(0x400, section + 20);
  const root = 0x400;
  const typeDirectory = 0x20;
  const languageDirectory = 0x40;
  const dataEntryRelative = 0x60;
  const versionRelative = 0x100;
  bytes.writeUInt16LE(1, root + 14);
  bytes.writeUInt32LE(16, root + 16);
  bytes.writeUInt32LE((0x80000000 | typeDirectory) >>> 0, root + 20);
  bytes.writeUInt16LE(1, root + typeDirectory + 14);
  bytes.writeUInt32LE(1, root + typeDirectory + 16);
  bytes.writeUInt32LE((0x80000000 | languageDirectory) >>> 0, root + typeDirectory + 20);
  bytes.writeUInt16LE(1, root + languageDirectory + 14);
  bytes.writeUInt32LE(0x0409, root + languageDirectory + 16);
  bytes.writeUInt32LE(dataEntryRelative, root + languageDirectory + 20);
  const resource = versionResource();
  bytes.writeUInt32LE(0x1000 + versionRelative, root + dataEntryRelative);
  bytes.writeUInt32LE(resource.length, root + dataEntryRelative + 4);
  resource.copy(bytes, root + versionRelative);
  return Object.freeze({ bytes, rootOffset: root, dataEntryOffset: root + dataEntryRelative });
};

describe("bounded PE VERSIONINFO parser", () => {
  it("extracts exact fixed and string versions without executing an image", () => {
    const fixture = syntheticPe();
    expect(parsePeVersionInfo(fixture.bytes)).toEqual({
      fixedFileVersion: "10.0.3.49839",
      fixedProductVersion: "10.0.3.49839",
      fileVersion: "10.0.3.49839",
      productVersion: "10.0.3",
      originalFilename: "pcbnew.exe",
      internalName: "pcbnew",
    });
  });

  it("rejects truncated, overflowing, and ambiguous RT_VERSION resources", () => {
    const truncated = syntheticPe();
    expect(() => parsePeVersionInfo(truncated.bytes.subarray(0, 0x450))).toThrow(/bounded|backed|escapes/iu);
    const overflowing = syntheticPe();
    overflowing.bytes.writeUInt32LE(0xfffffff0, overflowing.dataEntryOffset + 4);
    expect(() => parsePeVersionInfo(overflowing.bytes)).toThrow(/map|backed|escapes/iu);
    const ambiguous = syntheticPe();
    ambiguous.bytes.writeUInt16LE(2, ambiguous.rootOffset + 14);
    ambiguous.bytes.writeUInt32LE(16, ambiguous.rootOffset + 24);
    ambiguous.bytes.writeUInt32LE(0x80000020, ambiguous.rootOffset + 28);
    expect(() => parsePeVersionInfo(ambiguous.bytes)).toThrow(/exactly one RT_VERSION/iu);
  });

  it.skipIf(process.platform !== "win32")("parses the installed KiCad 10.0.3 CLI and PCB editor without launching either", async () => {
    const cli = path.resolve(process.env.EVLEDA_KICAD_CLI ?? "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe");
    const editor = path.join(path.dirname(cli), "pcbnew.exe");
    const [cliInfo, editorInfo] = await Promise.all([readFile(cli).then(parsePeVersionInfo), readFile(editor).then(parsePeVersionInfo)]);
    expect(cliInfo).toMatchObject({ fixedFileVersion: "10.0.3.49839", fileVersion: "10.0.3.49839", productVersion: "10.0.3" });
    expect(editorInfo).toEqual({ fixedFileVersion: "10.0.3.49839", fixedProductVersion: "10.0.3.49839", fileVersion: "10.0.3.49839", productVersion: "10.0.3", originalFilename: "pcbnew.exe", internalName: "pcbnew" });
  });
});

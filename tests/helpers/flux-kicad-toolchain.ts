import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createFluxKicadToolchainBinding, type FluxKicadToolchainBinding } from "../../src/flux/kicad-toolchain-binding.js";
import type { BoundedProcessOptions, BoundedProcessResult, BoundedProcessRunner } from "../../src/integrations/bounded-process.js";

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
  body.writeUInt16LE(body.length, 0); body.writeUInt16LE(valueLength, 2); body.writeUInt16LE(type, 4); keyBytes.copy(body, 6);
  return body;
};
const stringBlock = (key: string, value: string): Buffer => { const bytes = utf16z(value); return block(key, 1, bytes, bytes.length / 2); };

export const syntheticKiCadPe = (role: "kicad-cli" | "pcbnew", fileVersion = "10.0.3.49839", productVersion = "10.0.3"): Buffer => {
  const fixed = Buffer.alloc(52);
  const parts = fileVersion.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65_535)) throw new Error("Synthetic KiCad PE version is invalid");
  const [most, least] = versionWords(parts as unknown as readonly [number, number, number, number]);
  fixed.writeUInt32LE(0xfeef04bd, 0); fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(most, 8); fixed.writeUInt32LE(least, 12); fixed.writeUInt32LE(most, 16); fixed.writeUInt32LE(least, 20);
  const strings = block("040904b0", 1, Buffer.alloc(0), 0, [
    stringBlock("FileVersion", fileVersion), stringBlock("ProductVersion", productVersion),
    stringBlock("OriginalFilename", role === "pcbnew" ? "pcbnew.exe" : "kicad.exe"),
    stringBlock("InternalName", role === "pcbnew" ? "pcbnew" : "kicad"),
  ]);
  const resource = block("VS_VERSION_INFO", 0, fixed, fixed.length, [block("StringFileInfo", 1, Buffer.alloc(0), 0, [strings])]);
  const bytes = Buffer.alloc(0x2000, role === "pcbnew" ? 0xa5 : 0x5a);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 0x3c); bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84); bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(0xf0, 0x94);
  const optional = 0x98; bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1000, optional + 128); bytes.writeUInt32LE(0x1000, optional + 132);
  const section = optional + 0xf0; bytes.write(".rsrc\0\0\0", section, "ascii");
  bytes.writeUInt32LE(0x1000, section + 8); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(0x1000, section + 16); bytes.writeUInt32LE(0x400, section + 20);
  const root = 0x400; bytes.fill(0, root, root + 0x100 + resource.length);
  bytes.writeUInt16LE(1, root + 14); bytes.writeUInt32LE(16, root + 16); bytes.writeUInt32LE(0x80000020, root + 20);
  bytes.writeUInt16LE(1, root + 0x20 + 14); bytes.writeUInt32LE(1, root + 0x20 + 16); bytes.writeUInt32LE(0x80000040, root + 0x20 + 20);
  bytes.writeUInt16LE(1, root + 0x40 + 14); bytes.writeUInt32LE(0x0409, root + 0x40 + 16); bytes.writeUInt32LE(0x60, root + 0x40 + 20);
  bytes.writeUInt32LE(0x1100, root + 0x60); bytes.writeUInt32LE(resource.length, root + 0x64); resource.copy(bytes, root + 0x100);
  return bytes;
};

export interface FakeFluxKicadToolchain {
  readonly toolchain: FluxKicadToolchainBinding;
  readonly runner: BoundedProcessRunner;
  readonly calls: BoundedProcessOptions[];
  readonly cliPath: string;
  readonly pcbnewPath: string;
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export const createFakeFluxKicadToolchain = async (root: string, suiteVersion = "10.0.3", fileVersion = "10.0.3.49839"): Promise<FakeFluxKicadToolchain> => {
  const binRoot = path.resolve(root, "kicad-bin"); await mkdir(binRoot, { recursive: true });
  const cliPath = path.join(binRoot, "kicad-cli.exe"); const pcbnewPath = path.join(binRoot, "pcbnew.exe");
  const cliBytes = syntheticKiCadPe("kicad-cli", fileVersion, suiteVersion); const pcbnewBytes = syntheticKiCadPe("pcbnew", fileVersion, suiteVersion);
  await Promise.all([writeFile(cliPath, cliBytes), writeFile(pcbnewPath, pcbnewBytes)]);
  const toolchain = createFluxKicadToolchainBinding({
    binRoot,
    kicadCli: { path: cliPath, contentIdentity: { algorithm: "sha256", digest: digest(cliBytes), size: cliBytes.length }, operationalVersion: suiteVersion, operationalCommit: "1".repeat(40), peFileVersion: fileVersion, peProductVersion: suiteVersion },
    pcbnew: { path: pcbnewPath, contentIdentity: { algorithm: "sha256", digest: digest(pcbnewBytes), size: pcbnewBytes.length }, peFileVersion: fileVersion, peProductVersion: suiteVersion },
  });
  const calls: BoundedProcessOptions[] = [];
  const runner: BoundedProcessRunner = async (options): Promise<BoundedProcessResult> => {
    calls.push(options);
    if (path.resolve(options.command) !== cliPath) throw new Error("The PCB editor must never be invoked as an identity probe.");
    const joined = options.args.join(" ");
    const stdout = joined === "version" ? `${suiteVersion}\r\n` : joined === "version --format commit" ? `${"1".repeat(40)}\r\n` : "";
    if (!stdout) throw new Error(`Unexpected KiCad CLI probe: ${joined}`);
    return { command: options.command, args: [...options.args], cwd: options.cwd, exitCode: 0, stdout, stderr: "", durationMs: 1, startedAt: "2026-09-07T00:00:00.000Z" };
  };
  return Object.freeze({ toolchain, runner, calls, cliPath, pcbnewPath });
};

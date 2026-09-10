export interface PeVersionInfo {
  readonly fixedFileVersion: string;
  readonly fixedProductVersion: string;
  readonly fileVersion: string;
  readonly productVersion: string;
  readonly originalFilename: string;
  readonly internalName: string;
}

export class PeVersionInfoError extends Error {
  override readonly name = "PeVersionInfoError";
}

const MAX_PE_BYTES = 128 * 1024 * 1024;
const MAX_SECTIONS = 96;
const MAX_RESOURCE_ENTRIES = 1_024;
const RT_VERSION = 16;
const VS_FIXEDFILEINFO_BYTES = 52;
const VS_FIXEDFILEINFO_SIGNATURE = 0xfeef04bd;

const fail = (message: string): never => { throw new PeVersionInfoError(message); };
const aligned4 = (value: number): number => (value + 3) & ~3;

const bounded = (buffer: Buffer, offset: number, length: number, label: string): void => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > buffer.length - length) {
    fail(`${label} escapes the bounded PE image.`);
  }
};

const u16 = (buffer: Buffer, offset: number, label: string): number => {
  bounded(buffer, offset, 2, label);
  return buffer.readUInt16LE(offset);
};

const u32 = (buffer: Buffer, offset: number, label: string): number => {
  bounded(buffer, offset, 4, label);
  return buffer.readUInt32LE(offset);
};

const version = (most: number, least: number): string =>
  `${String(most >>> 16)}.${String(most & 0xffff)}.${String(least >>> 16)}.${String(least & 0xffff)}`;

interface PeSection {
  readonly virtualAddress: number;
  readonly virtualSize: number;
  readonly rawOffset: number;
  readonly rawSize: number;
}

interface VersionBlock {
  readonly start: number;
  readonly end: number;
  readonly key: string;
  readonly type: number;
  readonly valueLength: number;
  readonly valueOffset: number;
  readonly childrenOffset: number;
}

const utf16z = (buffer: Buffer, offset: number, limit: number, label: string): Readonly<{ readonly value: string; readonly end: number }> => {
  if (offset < 0 || limit > buffer.length || offset >= limit) fail(`${label} is missing.`);
  let cursor = offset;
  while (cursor + 2 <= limit) {
    if (buffer.readUInt16LE(cursor) === 0) {
      const value = buffer.subarray(offset, cursor).toString("utf16le");
      if (!value || value.includes("\0")) fail(`${label} is invalid.`);
      return Object.freeze({ value, end: cursor + 2 });
    }
    cursor += 2;
  }
  return fail(`${label} is not NUL terminated.`);
};

const blockAt = (buffer: Buffer, start: number, parentEnd: number, label: string): VersionBlock => {
  bounded(buffer, start, 6, label);
  const length = u16(buffer, start, `${label} length`);
  const valueLength = u16(buffer, start + 2, `${label} value length`);
  const type = u16(buffer, start + 4, `${label} type`);
  if (length < 8 || start > parentEnd - length) fail(`${label} length is invalid.`);
  const end = start + length;
  const key = utf16z(buffer, start + 6, end, `${label} key`);
  const valueOffset = aligned4(key.end);
  if (valueOffset > end) fail(`${label} value offset is invalid.`);
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  if (!Number.isSafeInteger(valueBytes) || valueOffset > end - valueBytes) fail(`${label} value escapes its block.`);
  return Object.freeze({ start, end, key: key.value, type, valueLength, valueOffset, childrenOffset: aligned4(valueOffset + valueBytes) });
};

const collectStringValues = (buffer: Buffer, root: VersionBlock): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  let blockCount = 0;
  const visitChildren = (parent: VersionBlock, depth: number): void => {
    if (depth > 4) fail("PE version string hierarchy is too deep.");
    let cursor = parent.childrenOffset;
    while (cursor + 2 <= parent.end) {
      while (cursor + 2 <= parent.end && buffer.readUInt16LE(cursor) === 0) cursor += 2;
      cursor = aligned4(cursor);
      if (cursor + 2 > parent.end) return;
      const childLength = buffer.readUInt16LE(cursor);
      if (childLength === 0) return;
      blockCount += 1;
      if (blockCount > MAX_RESOURCE_ENTRIES) fail("PE version resource contains too many blocks.");
      const child = blockAt(buffer, cursor, parent.end, "PE version child block");
      if (["FileVersion", "ProductVersion", "OriginalFilename", "InternalName"].includes(child.key)) {
        if (child.type !== 1 || child.valueLength < 1) fail(`PE ${child.key} value has an invalid type.`);
        const raw = buffer.subarray(child.valueOffset, child.valueOffset + child.valueLength * 2).toString("utf16le");
        const value = raw.replace(/\0+$/u, "");
        if (!value || value.includes("\0")) fail(`PE ${child.key} value is invalid.`);
        const prior = values.get(child.key);
        if (prior !== undefined && prior !== value) fail(`PE ${child.key} values are ambiguous.`);
        values.set(child.key, value);
      }
      visitChildren(child, depth + 1);
      cursor = aligned4(child.end);
    }
  };
  visitChildren(root, 0);
  return values;
};

const resourceData = (buffer: Buffer): Buffer => {
  if (buffer.length < 0x40 || buffer.length > MAX_PE_BYTES || buffer.readUInt16LE(0) !== 0x5a4d) fail("Executable is not a bounded DOS/PE image.");
  const peOffset = u32(buffer, 0x3c, "PE header offset");
  bounded(buffer, peOffset, 24, "PE header");
  if (buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") fail("Executable has no PE signature.");
  const sectionCount = u16(buffer, peOffset + 6, "PE section count");
  const optionalSize = u16(buffer, peOffset + 20, "PE optional-header size");
  if (sectionCount < 1 || sectionCount > MAX_SECTIONS) fail("PE section count is outside policy.");
  const optionalOffset = peOffset + 24;
  bounded(buffer, optionalOffset, optionalSize, "PE optional header");
  const magic = u16(buffer, optionalOffset, "PE optional-header magic");
  const directoryOffset = magic === 0x10b ? optionalOffset + 96 : magic === 0x20b ? optionalOffset + 112 : fail("PE optional-header magic is unsupported.");
  const directoryCountOffset = magic === 0x10b ? optionalOffset + 92 : optionalOffset + 108;
  if (u32(buffer, directoryCountOffset, "PE data-directory count") <= 2 || directoryOffset + 24 > optionalOffset + optionalSize) fail("PE resource directory is absent.");
  const resourceRva = u32(buffer, directoryOffset + 16, "PE resource RVA");
  const resourceSize = u32(buffer, directoryOffset + 20, "PE resource size");
  if (resourceRva === 0 || resourceSize < 16) fail("PE resource directory is empty.");
  const sectionOffset = optionalOffset + optionalSize;
  bounded(buffer, sectionOffset, sectionCount * 40, "PE section table");
  const sections: PeSection[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    sections.push(Object.freeze({
      virtualSize: u32(buffer, offset + 8, "PE section virtual size"),
      virtualAddress: u32(buffer, offset + 12, "PE section virtual address"),
      rawSize: u32(buffer, offset + 16, "PE section raw size"),
      rawOffset: u32(buffer, offset + 20, "PE section raw offset"),
    }));
  }
  const rvaToOffset = (rva: number, size: number, label: string): number => {
    const matches = sections.filter((section) => {
      const span = Math.max(section.virtualSize, section.rawSize);
      return span > 0 && rva >= section.virtualAddress && rva - section.virtualAddress <= span - size;
    });
    if (matches.length !== 1) fail(`${label} does not map to exactly one PE section.`);
    const section = matches[0]!;
    const delta = rva - section.virtualAddress;
    if (delta > section.rawSize - size) fail(`${label} is not backed by section bytes.`);
    const offset = section.rawOffset + delta;
    bounded(buffer, offset, size, label);
    return offset;
  };
  const resourceOffset = rvaToOffset(resourceRva, resourceSize, "PE resource directory");
  const relative = (offset: number, length: number, label: string): number => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > resourceSize - length) fail(`${label} escapes the PE resource directory.`);
    const absolute = resourceOffset + offset;
    bounded(buffer, absolute, length, label);
    return absolute;
  };
  const entries = (directoryRelative: number, label: string): readonly Readonly<{ readonly id: number | undefined; readonly target: number; readonly directory: boolean }>[] => {
    const directory = relative(directoryRelative, 16, label);
    const count = u16(buffer, directory + 12, `${label} named count`) + u16(buffer, directory + 14, `${label} ID count`);
    if (count < 1 || count > MAX_RESOURCE_ENTRIES) fail(`${label} entry count is outside policy.`);
    relative(directoryRelative + 16, count * 8, `${label} entries`);
    const result = [];
    for (let index = 0; index < count; index += 1) {
      const offset = directory + 16 + index * 8;
      const name = u32(buffer, offset, `${label} entry name`);
      const child = u32(buffer, offset + 4, `${label} entry target`);
      result.push(Object.freeze({ id: (name & 0x80000000) === 0 ? name & 0xffff : undefined, target: child & 0x7fffffff, directory: (child & 0x80000000) !== 0 }));
    }
    return Object.freeze(result);
  };
  const versionTypes = entries(0, "PE resource root").filter((entry) => entry.id === RT_VERSION && entry.directory);
  if (versionTypes.length !== 1) fail("PE must contain exactly one RT_VERSION directory.");
  const versionDataEntries: number[] = [];
  for (const nameEntry of entries(versionTypes[0]!.target, "PE RT_VERSION directory")) {
    if (!nameEntry.directory) fail("PE RT_VERSION name entry is not a directory.");
    for (const languageEntry of entries(nameEntry.target, "PE RT_VERSION language directory")) {
      if (languageEntry.directory) fail("PE RT_VERSION language entry unexpectedly points to a directory.");
      versionDataEntries.push(languageEntry.target);
    }
  }
  if (versionDataEntries.length !== 1) fail("PE RT_VERSION data is missing or ambiguous.");
  const dataEntry = relative(versionDataEntries[0]!, 16, "PE RT_VERSION data entry");
  const dataRva = u32(buffer, dataEntry, "PE RT_VERSION data RVA");
  const dataSize = u32(buffer, dataEntry + 4, "PE RT_VERSION data size");
  if (dataSize < VS_FIXEDFILEINFO_BYTES) fail("PE RT_VERSION data is too small.");
  const dataOffset = rvaToOffset(dataRva, dataSize, "PE RT_VERSION data");
  return buffer.subarray(dataOffset, dataOffset + dataSize);
};

export const parsePeVersionInfo = (input: Uint8Array): PeVersionInfo => {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const resource = resourceData(buffer);
  const root = blockAt(resource, 0, resource.length, "VS_VERSION_INFO");
  if (root.key !== "VS_VERSION_INFO" || root.type !== 0 || root.valueLength !== VS_FIXEDFILEINFO_BYTES) fail("PE version root is invalid.");
  const fixed = root.valueOffset;
  bounded(resource, fixed, VS_FIXEDFILEINFO_BYTES, "VS_FIXEDFILEINFO");
  if (u32(resource, fixed, "VS_FIXEDFILEINFO signature") !== VS_FIXEDFILEINFO_SIGNATURE || u32(resource, fixed + 4, "VS_FIXEDFILEINFO structure version") !== 0x00010000) {
    fail("VS_FIXEDFILEINFO signature or structure version is invalid.");
  }
  const strings = collectStringValues(resource, root);
  const required = ["FileVersion", "ProductVersion", "OriginalFilename", "InternalName"] as const;
  if (required.some((key) => strings.get(key) === undefined)) fail("PE version string table is incomplete.");
  return Object.freeze({
    fixedFileVersion: version(u32(resource, fixed + 8, "fixed file version MS"), u32(resource, fixed + 12, "fixed file version LS")),
    fixedProductVersion: version(u32(resource, fixed + 16, "fixed product version MS"), u32(resource, fixed + 20, "fixed product version LS")),
    fileVersion: strings.get("FileVersion")!,
    productVersion: strings.get("ProductVersion")!,
    originalFilename: strings.get("OriginalFilename")!,
    internalName: strings.get("InternalName")!,
  });
};

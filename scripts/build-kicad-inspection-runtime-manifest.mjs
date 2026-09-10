import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA = "evleda.kicad-mcp-runtime-manifest.v2";
const MAX_FILES = 20_000;
const MAX_DIRECTORIES = 5_000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const EXPECTED_ENTRY_POINT = "kicad-mcp-pro = kicad_mcp.server:main\n";
const EXPECTED_PTH = new Map([
  ["environment/Lib/site-packages/_virtualenv.pth", "import _virtualenv"],
  ["environment/Lib/site-packages/pywin32.pth", "# .pth file for the PyWin32 extensions\nwin32\nwin32\\lib\npythonwin\n# And some hackery to deal with environments where the post_install script\n# isn't run.\nimport pywin32_bootstrap\n"],
]);
const SYSTEM_DLLS = new Set([
  "aclui.dll", "activeds.dll", "advapi32.dll", "bcrypt.dll", "bcryptprimitives.dll", "cabinet.dll", "cfgmgr32.dll",
  "combase.dll", "comctl32.dll", "comdlg32.dll", "credui.dll", "crypt32.dll", "dbghelp.dll", "dsound.dll",
  "dwmapi.dll", "framedynos.dll", "gdi32.dll", "gdiplus.dll", "imm32.dll", "iphlpapi.dll", "kernel32.dll", "ktmw32.dll",
  "loadperf.dll", "lz32.dll", "mpr.dll", "msimg32.dll", "msvcrt.dll", "mswsock.dll", "netapi32.dll",
  "netutils.dll", "normaliz.dll", "ntdll.dll", "ntdsapi.dll", "odbc32.dll", "ole32.dll", "oleacc.dll", "oleaut32.dll",
  "oledlg.dll", "pdh.dll", "powrprof.dll", "propsys.dll", "psapi.dll", "query.dll", "rasapi32.dll",
  "rpcrt4.dll", "secur32.dll", "setupapi.dll", "sfc.dll", "shell32.dll", "shlwapi.dll", "srvcli.dll", "sspicli.dll", "urlmon.dll",
  "user32.dll", "userenv.dll", "uxtheme.dll", "version.dll", "wevtapi.dll", "winhttp.dll", "wininet.dll",
  "winmm.dll", "winspool.drv", "wintrust.dll", "wldap32.dll", "ws2_32.dll", "wtsapi32.dll",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const canonical = (value) => JSON.stringify(stable(value));
const identity = (value, schemaVersion) => ({
  algorithm: "sha256",
  digest: sha256(Buffer.from(canonical(value), "utf8")),
  schemaVersion,
  canonicalizationVersion: "evleda-c14n-json-v1",
});
const normalizedPath = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const samePath = (left, right) => normalizedPath(path.resolve(left)) === normalizedPath(path.resolve(right));
const relativePath = (root, candidate) => {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || relative.includes("/../") || path.isAbsolute(relative)) throw new Error("Runtime entry escaped its root");
  return relative;
};

async function assertChain(candidate) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const metadata = await lstat(cursor, { bigint: true });
    if (metadata.isSymbolicLink() || !samePath(cursor, await realpath(cursor))) throw new Error("Runtime ancestor is an alias or reparse point");
  }
}

async function captureFile(root, filePath) {
  await assertChain(filePath);
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(MAX_FILE_BYTES)) throw new Error("Runtime file identity is unsupported");
    const hash = createHash("sha256");
    const chunks = [];
    let seen = 0;
    for await (const chunkValue of handle.createReadStream({ autoClose: false, start: 0 })) {
      const chunk = Buffer.from(chunkValue);
      seen += chunk.length;
      if (seen > MAX_FILE_BYTES) throw new Error("Runtime file exceeded its cap while reading");
      chunks.push(chunk);
      hash.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    const atPath = await lstat(filePath, { bigint: true });
    for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "birthtimeNs"]) {
      if (before[field] !== after[field] || before[field] !== atPath[field]) throw new Error("Runtime file changed during capture");
    }
    if (seen !== Number(before.size)) throw new Error("Runtime file size changed during capture");
    return {
      record: { path: relativePath(root, filePath), sizeBytes: seen, sha256: hash.digest("hex"), mode: Number(before.mode & 0o777n) },
      bytes: Buffer.concat(chunks, seen),
    };
  } finally { await handle.close(); }
}

async function scanTree(root) {
  await assertChain(root);
  const canonicalRoot = await realpath(root);
  if (!samePath(root, canonicalRoot)) throw new Error("Runtime root is an alias");
  const files = [];
  const directories = [];
  const bytesByPath = new Map();
  const pending = [canonicalRoot];
  let totalBytes = 0;
  while (pending.length) {
    const directory = pending.pop();
    const metadata = await lstat(directory, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Runtime contains a non-directory container");
    if (directory !== canonicalRoot) directories.push({ path: relativePath(canonicalRoot, directory), mode: Number(metadata.mode & 0o777n) });
    if (directories.length > MAX_DIRECTORIES) throw new Error("Runtime directory count exceeds cap");
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Runtime contains a direct link");
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) {
        const captured = await captureFile(canonicalRoot, candidate);
        files.push(captured.record);
        bytesByPath.set(captured.record.path, captured.bytes);
        totalBytes += captured.record.sizeBytes;
        if (files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) throw new Error("Runtime tree exceeds aggregate caps");
      } else throw new Error("Runtime contains an unsupported filesystem entry");
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  directories.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  return { root: canonicalRoot, files, directories, bytesByPath, totalBytes };
}

function cString(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) throw new Error("PE string offset is invalid");
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  if (end === buffer.length || end - offset > 512) throw new Error("PE import name is invalid");
  return buffer.subarray(offset, end).toString("ascii");
}

function peImports(buffer) {
  if (buffer.length < 0x100 || buffer.toString("ascii", 0, 2) !== "MZ") throw new Error("Native runtime file is not a PE image");
  const pe = buffer.readUInt32LE(0x3c);
  if (pe + 24 > buffer.length || buffer.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("PE header is invalid");
  const sectionCount = buffer.readUInt16LE(pe + 6);
  const optionalSize = buffer.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const magic = buffer.readUInt16LE(optional);
  const directoryBase = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : -1;
  if (directoryBase < 0 || optional + optionalSize > buffer.length) throw new Error("PE optional header is invalid");
  const sections = [];
  const sectionBase = optional + optionalSize;
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionBase + index * 40;
    if (offset + 40 > buffer.length) throw new Error("PE section table is invalid");
    sections.push({ virtualSize: buffer.readUInt32LE(offset + 8), virtualAddress: buffer.readUInt32LE(offset + 12), rawSize: buffer.readUInt32LE(offset + 16), rawOffset: buffer.readUInt32LE(offset + 20) });
  }
  const mapRva = (rva) => {
    if (rva < buffer.length && rva < (sections[0]?.virtualAddress ?? 0)) return rva;
    const section = sections.find((entry) => rva >= entry.virtualAddress && rva < entry.virtualAddress + Math.max(entry.virtualSize, entry.rawSize));
    if (!section) throw new Error("PE import RVA is outside all sections");
    const offset = section.rawOffset + (rva - section.virtualAddress);
    if (offset < 0 || offset >= buffer.length) throw new Error("PE import RVA maps outside the file");
    return offset;
  };
  const names = new Set();
  const readTable = (rva, stride, nameOffset) => {
    if (rva === 0) return;
    let offset = mapRva(rva);
    for (let count = 0; count < 4096; count += 1, offset += stride) {
      if (offset + stride > buffer.length) throw new Error("PE import table is truncated");
      let empty = true;
      for (let cursor = 0; cursor < stride; cursor += 4) if (buffer.readUInt32LE(offset + cursor) !== 0) empty = false;
      if (empty) return;
      const nameRva = buffer.readUInt32LE(offset + nameOffset);
      names.add(cString(buffer, mapRva(nameRva)).toLowerCase());
    }
    throw new Error("PE import table exceeds its cap");
  };
  readTable(buffer.readUInt32LE(directoryBase + 8), 20, 12);
  if (directoryBase + 13 * 8 + 8 <= optional + optionalSize) readTable(buffer.readUInt32LE(directoryBase + 13 * 8), 32, 4);
  return [...names].sort();
}

function validatePolicy(scan, expectedFinalRoot) {
  const byPath = new Map(scan.files.map((entry) => [entry.path, entry]));
  const pythonPath = "environment/Scripts/python.exe";
  const launcherPath = "kicad-inspection-launcher.py";
  const metadataPath = "environment/Lib/site-packages/kicad_mcp_pro-3.33.3.dist-info/METADATA";
  const entryPointsPath = "environment/Lib/site-packages/kicad_mcp_pro-3.33.3.dist-info/entry_points.txt";
  for (const required of [pythonPath, launcherPath, metadataPath, entryPointsPath, "environment/pyvenv.cfg"]) if (!byPath.has(required)) throw new Error(`Runtime is missing ${required}`);
  const entryPoints = scan.bytesByPath.get(entryPointsPath).toString("utf8").replace(/\r\n/gu, "\n");
  if (entryPoints !== `[console_scripts]\n${EXPECTED_ENTRY_POINT}`) throw new Error("kicad-mcp-pro console entrypoint differs from the audited target");
  const metadata = scan.bytesByPath.get(metadataPath).toString("utf8");
  if (!/^Name: kicad-mcp-pro$/mu.test(metadata) || !/^Version: 3\.33\.3$/mu.test(metadata)) throw new Error("kicad-mcp-pro package metadata is invalid");
  const pyvenv = scan.bytesByPath.get("environment/pyvenv.cfg").toString("utf8").replace(/\r\n/gu, "\n");
  const expectedHome = path.join(expectedFinalRoot, "python");
  if (!pyvenv.includes(`home = ${expectedHome}\n`) || !pyvenv.includes("include-system-site-packages = false\n") || !pyvenv.includes("version_info = 3.13.12\n")) throw new Error("Relocated pyvenv binding is invalid");
  const pthPaths = scan.files.filter((entry) => entry.path.toLowerCase().endsWith(".pth")).map((entry) => entry.path);
  if (canonical(pthPaths) !== canonical([...EXPECTED_PTH.keys()].sort())) throw new Error("Runtime .pth inventory is not closed");
  for (const [pthPath, expected] of EXPECTED_PTH) {
    const actual = scan.bytesByPath.get(pthPath).toString("utf8").replace(/\r\n/gu, "\n");
    if (actual !== expected) throw new Error(`Runtime ${pthPath} is not the audited relative-only form`);
  }
  if (scan.files.some((entry) => /(?:^|\/)(?:sitecustomize|usercustomize)\.py$/iu.test(entry.path) || entry.path.toLowerCase().endsWith(".pyc"))) throw new Error("Runtime contains ambient Python customization or bytecode");
  const forbidden = ["\\runtime\\uv-cache\\", "3leWt0H2aCaOpxjF", "\\runtime\\python\\cpython-3.13.12-windows-x86_64-none"];
  for (const [filePath, bytes] of scan.bytesByPath) {
    const utf8 = bytes.toString("utf8");
    const utf16 = bytes.toString("utf16le");
    if (forbidden.some((fragment) => utf8.includes(fragment) || utf16.includes(fragment))) throw new Error(`Runtime ${filePath} retains an original cache/interpreter path`);
  }
  const packages = scan.directories
    .map((entry) => /^environment\/Lib\/site-packages\/([^/]+\.dist-info)$/u.exec(entry.path)?.[1])
    .filter(Boolean)
    .sort();
  const normalizedPackages = packages.map((name) => name.replace(/\.dist-info$/u, "").replace(/[-_.]+/gu, "-").toLowerCase());
  if (new Set(normalizedPackages).size !== normalizedPackages.length || !normalizedPackages.includes("kicad-mcp-pro-3-33-3") || !normalizedPackages.includes("mcp-1-29-1") || !normalizedPackages.includes("kicad-python-0-7-1")) throw new Error("Runtime package closure is ambiguous or incomplete");
  const availableDlls = new Set(scan.files.map((entry) => path.posix.basename(entry.path).toLowerCase()));
  const nativeImports = [];
  const unresolvedNativeImports = [];
  for (const file of scan.files.filter((entry) => /\.(?:exe|dll|pyd)$/iu.test(entry.path))) {
    const imports = peImports(scan.bytesByPath.get(file.path));
    for (const dependency of imports) {
      if (availableDlls.has(dependency) || SYSTEM_DLLS.has(dependency) || dependency.startsWith("api-ms-win-") || dependency.startsWith("ext-ms-win-")) continue;
      unresolvedNativeImports.push({ dependency, path: file.path });
    }
    nativeImports.push({ path: file.path, imports });
  }
  if (unresolvedNativeImports.length > 0) {
    throw new Error(`Native dependencies outside the bundle/system policy: ${JSON.stringify(unresolvedNativeImports.slice(0, 256))}`);
  }
  return { pythonPath, launcherPath, metadataPath, entryPointsPath, packages, nativeImports };
}

async function build(root, manifestPath, expectedFinalRoot) {
  const scan = await scanTree(root);
  const policy = validatePolicy(scan, path.resolve(expectedFinalRoot));
  const treePayload = { directories: scan.directories, files: scan.files };
  const treeIdentity = identity(treePayload, "evleda.kicad-mcp-inspection-runtime-tree.v1");
  const fileByPath = new Map(scan.files.map((entry) => [entry.path, entry]));
  const payload = {
    schemaVersion: SCHEMA,
    classification: "pinned-local-kicad-mcp-runtime",
    platform: "win32-x64",
    distribution: { name: "kicad-mcp-pro", version: "3.33.3" },
    protocol: { serverName: "kicad-mcp-pro", serverVersion: "1.29.1", transport: "stdio", modes: ["readonly", "write"] },
    python: { version: "3.13.12", relativePath: policy.pythonPath, contentIdentity: { algorithm: "sha256", digest: fileByPath.get(policy.pythonPath).sha256, size: fileByPath.get(policy.pythonPath).sizeBytes } },
    entrypoint: { relativePath: policy.launcherPath, callable: "kicad_mcp.server:_run_server_from_options", contentIdentity: { algorithm: "sha256", digest: fileByPath.get(policy.launcherPath).sha256, size: fileByPath.get(policy.launcherPath).sizeBytes } },
    packageMetadata: { relativePath: policy.metadataPath, consoleEntryPointRelativePath: policy.entryPointsPath, packages: policy.packages },
    pthPolicy: { paths: [...EXPECTED_PTH.keys()].sort(), siteCustomization: "forbidden", bytecode: "forbidden" },
    nativeDependencyPolicy: { systemDlls: [...SYSTEM_DLLS].sort(), images: policy.nativeImports },
    fileCount: scan.files.length,
    directoryCount: scan.directories.length,
    totalBytes: scan.totalBytes,
    treeIdentity,
    directories: scan.directories,
    files: scan.files,
  };
  const manifest = { ...payload, identity: identity(payload, SCHEMA) };
  await writeFile(manifestPath, `${canonical(manifest)}\n`, { encoding: "utf8", flag: "wx" });
  return manifest;
}

async function verify(root, manifestPath, expectedFinalRoot) {
  const exact = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(exact);
  if (exact !== `${canonical(parsed)}\n`) throw new Error("Manifest bytes are not exact canonical JSON plus LF");
  const temporary = `${manifestPath}.${process.pid}.verify.tmp`;
  const rebuilt = await build(root, temporary, expectedFinalRoot);
  try {
    if (canonical(parsed) !== canonical(rebuilt)) throw new Error("Runtime tree does not reproduce the pinned manifest");
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { force: true });
  }
  return rebuilt;
}

const [mode, root, manifestPath, expectedFinalRoot] = process.argv.slice(2);
if (!mode || !root || !manifestPath || !expectedFinalRoot || !["build", "verify"].includes(mode)) {
  throw new Error("Usage: node build-kicad-inspection-runtime-manifest.mjs build|verify <root> <manifest> <expected-final-root>");
}
const result = mode === "build"
  ? await build(path.resolve(root), path.resolve(manifestPath), path.resolve(expectedFinalRoot))
  : await verify(path.resolve(root), path.resolve(manifestPath), path.resolve(expectedFinalRoot));
process.stdout.write(`${JSON.stringify({ fileCount: result.fileCount, directoryCount: result.directoryCount, totalBytes: result.totalBytes, treeIdentity: result.treeIdentity, manifestIdentity: result.identity })}\n`);

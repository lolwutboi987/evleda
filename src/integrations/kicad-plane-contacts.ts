import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, parsePortableJsonBytes } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { createKicadSavedSourceReader } from "./kicad-saved-source.js";
import { runBoundedProcess, type BoundedProcessRunner, type BoundedWindowsProcessTreeTermination } from "./bounded-process.js";
import { captureKicadStartupCause } from "./kicad-startup-diagnostic.js";

const MAX_OUTPUT = 16 * 1024 * 1024 - 64 * 1024, MAX_FILE = 64 * 1024 * 1024, MAX_RUNTIME = 512 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/u), integer = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const text = z.string().max(4096), pathname = z.string().min(1).max(32768);
const identitySchema = z.object({ sha256: hash, sizeBytes: z.number().int().positive().max(MAX_FILE) }).strict();
const fileIdentitySchema = identitySchema.extend({ path: pathname }).strict();
const uuid = z.string().regex(/^(?!00000000-0000-0000-0000-000000000000$)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const layer = z.object({ id: z.number().int().min(0).max(127), name: text }).strict();
const point = z.tuple([integer, integer]);
const contour = z.array(point).min(3).max(250000);
const subpolygon = z.object({ index: z.number().int().min(0).max(99999), sha256: hash, isIsland: z.boolean(), outline: contour, holes: z.array(contour).max(100000) }).strict();
const nativeItem = z.object({ uuid, nativeType: integer, nativeClass: z.enum(["PAD", "PCB_TRACK", "PCB_ARC", "PCB_VIA", "ZONE"]), netCode: integer, netName: text }).strict();
const contact = nativeItem.extend({ proxyType: z.enum(["PAD", "PCB_TRACK", "PCB_ARC", "PCB_VIA"]) }).strict();
const pad = nativeItem.extend({ nativeClass: z.literal("PAD"), footprintUuid: uuid, reference: text, number: text, attribute: integer,
  localZoneConnection: integer, resolvedZoneConnectionOverride: integer, localThermalGapOverride: integer.nullable(),
  localThermalSpokeWidthOverride: integer.nullable(), padstackMode: integer, padstackUniqueLayers: z.array(integer).max(128),
  layers: z.array(layer.extend({ zoneLayerOverride: integer, effectivePadstackLayer: integer, hasExplicitPadstackDefinition: z.boolean() }).strict()).max(128) }).strict();
const footprint = z.object({ uuid, reference: text, localZoneConnection: integer, resolvedZoneConnectionOverride: integer }).strict();
const track = nativeItem.extend({ nativeClass: z.enum(["PCB_TRACK", "PCB_ARC", "PCB_VIA"]), layers: z.array(layer).max(128) }).strict();
const zone = nativeItem.extend({ nativeClass: z.literal("ZONE"), isRuleArea: z.boolean(), isFilled: z.boolean(), needRefill: z.boolean(),
  padConnection: integer, minimumThicknessNm: integer, directPads: z.array(contact).max(100000), directTracks: z.array(contact).max(100000), directVias: z.array(contact).max(100000),
  layers: z.array(layer.extend({ hasFilledPolys: z.boolean(), fillFlag: integer, filledSubpolygonCount: z.number().int().min(0).max(100000),
    filledGeometrySha256: hash, subpolygons: z.array(subpolygon).max(100000) }).strict()).max(128) }).strict();
const runtimeReport = z.object({ buildVersion: z.literal("10.0.3"), commitHash: z.literal("146a4f2a7585c65bc580427a19b6fe2ec4a3f622"), pythonVersion: text,
  pythonExecutable: fileIdentitySchema, pcbnewModule: fileIdentitySchema, nativeExtension: fileIdentitySchema, helper: fileIdentitySchema,
  importPaths: z.array(pathname).length(3), siteInitializationDisabled: z.literal(true), initialImportPaths: z.array(pathname).length(4), initialPrefix: pathname, initialBasePrefix: pathname,
  loadedPythonModules: z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z_0-9.]{0,127}$/u), fileIdentitySchema.extend({ origin: text.nullable(), bytecodeCachePath: pathname.nullable(), bytecodeCache: z.null() }).strict()),
  bundledNativeDependencies: z.array(fileIdentitySchema).min(1).max(1024), windowsSystemNativeDependencyPaths: z.array(pathname).min(1).max(1024) }).strict();
export const kicadPlaneContactsNativeReportSchema = z.object({ schemaVersion: z.literal("evleda.native-plane-contacts.v1"), ok: z.literal(true),
  source: z.object({ basename: text, before: identitySchema, after: identitySchema }).strict(), runtime: runtimeReport,
  connectivity: z.object({ built: z.literal(true), api: z.literal("direct-zone-neighbors"), zoneScope: z.literal("aggregate-native-subpolygons") }).strict(),
  inventory: z.object({ zoneCount: z.number().int().min(0).max(100000), padCount: z.number().int().min(0).max(100000), footprintCount: z.number().int().min(0).max(100000), trackCount: z.number().int().min(0).max(100000) }).strict(),
  capabilities: z.object({ perLayerPadstackZoneConnectionAvailable: z.literal(false), effectivePadZoneConnectionAvailable: z.literal(false), physicalThermalSpokeCountAvailable: z.literal(false) }).strict(),
  zones: z.array(zone).max(100000), allPads: z.array(pad).max(100000), allFootprints: z.array(footprint).max(100000), allTracks: z.array(track).max(100000) }).strict();
export type KicadPlaneContactsNativeReport = z.infer<typeof kicadPlaneContactsNativeReportSchema>;
export interface KicadPlaneContactsObservation {
  readonly schemaVersion: "evleda.kicad-plane-contacts-observation.v1";
  readonly sourceBefore: ContentIdentity;
  readonly sourceAfter: ContentIdentity;
  readonly sourceUnchanged: true;
  readonly report: KicadPlaneContactsNativeReport;
  readonly runtime: Readonly<{ manifestIdentity: ContentIdentity; helperIdentity: ContentIdentity; treeIdentity: CanonicalIdentity }>;
  readonly limitations: Readonly<{ foreignNetGeometricOverlaps: "not_assessed_by_direct_neighbors"; contactScope: "aggregate-native-subpolygons"; savedFillFreshness: "not_established" }>;
  readonly artifacts: Readonly<{ rawOutput: Readonly<{ path: string; identity: ContentIdentity }> }>;
}
const observations = new WeakSet<object>();
export function isKicadPlaneContactsObservation(value: unknown): value is KicadPlaneContactsObservation {
  return value !== null && typeof value === "object" && observations.has(value);
}
export interface KicadPlaneContactsOptions {
  readonly pcbPath: string;
  readonly expectedSourceIdentity: ContentIdentity;
  readonly runtimeRoot: string;
  readonly manifest: Readonly<{ path: string; contentIdentity: ContentIdentity }>;
  readonly helper: Readonly<{ path: string; contentIdentity: ContentIdentity }>;
  readonly outputRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination;
  readonly runner?: BoundedProcessRunner;
}
export interface KicadPlaneContactsReader { read(): Promise<KicadPlaneContactsObservation> }

const relative = z.string().min(1).max(512).refine(value => !value.includes("\\") && !value.includes(":") && !value.startsWith("/")
  && value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/[\u0000-\u001f]/u.test(part)));
const manifestSchema = z.object({ schemaVersion: z.literal("evleda.native-plane-contacts-isolated-runtime.v1"),
  classification: z.literal("qualified-isolated-runtime-candidate-not-production-authorization"), runtimeRoot: pathname,
  expectedBuildVersion: z.literal("10.0.3"), expectedCommitHash: z.literal("146a4f2a7585c65bc580427a19b6fe2ec4a3f622"), expectedPythonVersion: text,
  executableRelativePath: z.literal("bin/python.exe"), pythonArgs: z.tuple([z.literal("-I"), z.literal("-s"), z.literal("-E"), z.literal("-B"), z.literal("-S")]),
  workingDirectoryPolicy: z.literal("private-empty-directory-outside-runtime"), environmentOverrides: z.object({ PATH: pathname }).strict(), helper: fileIdentitySchema,
  privateEnvironmentPolicy: z.object({ inheritAmbientEnvironment: z.literal(false), noOtherVariables: z.literal(true),
    privatePathVariables: z.tuple([z.literal("HOME"), z.literal("USERPROFILE"), z.literal("APPDATA"), z.literal("LOCALAPPDATA"), z.literal("KICAD_CONFIG_HOME"), z.literal("TEMP"), z.literal("TMP")]),
    privateHomeDerivedVariables: z.tuple([z.literal("HOMEDRIVE"), z.literal("HOMEPATH")]), trustedSystemVariables: z.tuple([z.literal("SystemRoot"), z.literal("WINDIR"), z.literal("PATH")]) }).strict(),
  fileCount: z.number().int().min(1).max(1024), directoryCount: z.number().int().min(1).max(256), totalBytes: z.number().int().positive().max(MAX_RUNTIME),
  directories: z.array(relative).min(1).max(256), files: z.array(identitySchema.extend({ path: relative, originalPath: pathname }).strict()).min(1).max(1024),
  closedTreePolicy: z.object({ allowExtraFiles: z.literal(false), allowReparsePoints: z.literal(false), allowExtraDirectories: z.literal(false), verifyBeforeAndAfterExecution: z.literal(true), allowBytecode: z.literal(false) }).strict(),
  requiredAbsentRelativePaths: z.array(relative).min(1).max(128), windowsSystemNativeDependencyPaths: z.array(pathname).min(1).max(1024),
  provenance: z.record(z.string().max(64), z.unknown()), limits: z.array(z.string().max(2048)).max(16) }).strict();
type RuntimeManifest = z.infer<typeof manifestSchema>;
const normalized = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a: string, b: string) => normalized(a) === normalized(b);
const within = (root: string, file: string) => { const r = path.relative(normalized(root), normalized(file)); return r === "" || r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const sameStat = (a: BigIntStats, b: BigIntStats) => ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]
  .every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]);
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(`Native plane contacts: ${message}`); };
async function ordinaryChain(target: string): Promise<void> {
  assert(path.isAbsolute(target) && samePath(target, await realpath(target)), "host path is not canonical");
  let cursor = path.resolve(target);
  for (;;) {
    const metadata = await lstat(cursor);
    assert(!metadata.isSymbolicLink() && samePath(cursor, await realpath(cursor)), "path contains a link, junction or alias");
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function contentPin(pin: ContentIdentity, limit: number): void {
  assert(pin.algorithm === "sha256" && /^[a-f0-9]{64}$/u.test(pin.digest) && Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= limit, "invalid host content pin");
}
async function pinnedFile(file: string, pin: ContentIdentity, limit = MAX_FILE) {
  contentPin(pin, limit); await ordinaryChain(file);
  const before = await lstat(file, { bigint: true });
  assert(before.isFile() && before.nlink === 1n && before.size === BigInt(pin.size), "file type/size/pin mismatch");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true }); assert(sameStat(before, opened), "file changed while opening");
    const bytes = Buffer.alloc(pin.size + 1); let count = 0;
    while (count < bytes.length) { const part = await handle.read(bytes, count, bytes.length - count, count); if (part.bytesRead === 0) break; count += part.bytesRead; }
    assert(count === pin.size && contentIdentity(bytes.subarray(0, count)).digest === pin.digest, "file content pin mismatch");
    assert(sameStat(opened, await handle.stat({ bigint: true })) && sameStat(opened, await lstat(file, { bigint: true })), "file changed during capture");
    return { bytes: bytes.subarray(0, count), stat: opened };
  } finally { await handle.close(); }
}
const asContent = (pin: { sha256: string; sizeBytes: number }): ContentIdentity => ({ algorithm: "sha256", digest: pin.sha256, size: pin.sizeBytes });
const setEqual = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && a.every(value => b.includes(value));
const FORBIDDEN = /(?:^|\/)(?:__pycache__|pyvenv\.cfg|sitecustomize\.py|usercustomize\.py)(?:\/|$)|\.(?:pyc|pyo|pth|_pth|zip|local)$/iu;
const ABSENT = ["pyvenv.cfg", "bin/pyvenv.cfg", "bin/python._pth", "bin/python311._pth", "bin/python311.zip", "bin/python.exe.local", "bin/python311.dll.local",
  "bin/Lib/sitecustomize.py", "bin/Lib/usercustomize.py", "bin/Lib/site-packages/sitecustomize.py", "bin/Lib/site-packages/usercustomize.py",
  "bin/Lib/site-packages/pcbnew", "bin/Lib/site-packages/_pcbnew", "bin/Lib/site-packages/pcbnew.pyc", "bin/Lib/site-packages/pcbnew.pyd", "bin/Lib/site-packages/_pcbnew.py"];
async function scanRuntime(root: string, manifest: RuntimeManifest) {
  await ordinaryChain(root);
  const expected = new Map(manifest.files.map(file => [file.path.toLowerCase(), file]));
  assert(expected.size === manifest.files.length && manifest.files.length === manifest.fileCount && manifest.directories.length === manifest.directoryCount
    && new Set(manifest.directories.map(x => x.toLowerCase())).size === manifest.directories.length, "manifest closure counts or paths are ambiguous");
  assert(manifest.files.every(file => !FORBIDDEN.test(file.path) && /\.(?:exe|dll|pyd|py)$/iu.test(file.path))
    && manifest.directories.every(dir => !FORBIDDEN.test(dir)) && ABSENT.every(x => manifest.requiredAbsentRelativePaths.includes(x)), "manifest permits Python customization or incomplete absence policy");
  const files: string[] = [], directories: string[] = [], witnesses = new Map<string, BigIntStats>(); let total = 0;
  const visit = async (directory: string, rel: string) => {
    await ordinaryChain(directory); const stat = await lstat(directory, { bigint: true });
    assert(stat.isDirectory(), "runtime container is not a directory"); witnesses.set(rel, stat);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name), childRel = rel ? `${rel}/${entry.name}` : entry.name;
      assert(!entry.isSymbolicLink() && !FORBIDDEN.test(childRel), "runtime contains a link or Python customization");
      if (entry.isDirectory()) { assert(manifest.directories.includes(childRel), "runtime has an extra directory"); directories.push(childRel); await visit(child, childRel); }
      else {
        assert(entry.isFile(), "runtime has an unsupported entry"); const declared = expected.get(childRel.toLowerCase());
        assert(declared !== undefined && declared.path === childRel, "runtime has an extra or shadow file");
        const captured = await pinnedFile(child, asContent(declared)); witnesses.set(childRel, captured.stat); files.push(childRel); total += declared.sizeBytes;
      }
    }
    const after = await lstat(directory, { bigint: true }); assert(sameStat(stat, after), "runtime directory changed during capture");
  };
  await visit(root, "");
  assert(setEqual(files, manifest.files.map(x => x.path)) && setEqual(directories, manifest.directories) && total === manifest.totalBytes, "runtime closure differs from manifest");
  for (const rel of manifest.requiredAbsentRelativePaths) {
    try { await lstat(path.join(root, ...rel.split("/"))); throw new Error("Native plane contacts: forbidden startup path exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { witnesses, identity: canonicalIdentity({ files: manifest.files.map(({ path: filePath, sha256, sizeBytes }) => ({ path: filePath, sha256, sizeBytes })), directories: manifest.directories }, "evleda.native-plane-contacts-runtime-tree.v1") };
}

function validateNativeReport(report: KicadPlaneContactsNativeReport, manifest: RuntimeManifest, root: string, systemRoot: string, helper: KicadPlaneContactsOptions["helper"], source: ContentIdentity, pcbPath: string): void {
  assert(report.source.basename === path.basename(pcbPath) && canonicalJson(report.source.before) === canonicalJson({ sha256: source.digest, sizeBytes: source.size })
    && canonicalJson(report.source.before) === canonicalJson(report.source.after), "child source observations differ from host-pinned source");
  const bin = path.join(root, "bin"), rt = report.runtime;
  assert(rt.buildVersion === manifest.expectedBuildVersion && rt.commitHash === manifest.expectedCommitHash && rt.pythonVersion === manifest.expectedPythonVersion, "child runtime version differs from approved manifest");
  const declared = new Map(manifest.files.map(file => [normalized(path.join(root, ...file.path.split("/"))), file]));
  const checkRuntimePin = (item: z.infer<typeof fileIdentitySchema>) => {
    const pin = declared.get(normalized(item.path)); assert(path.isAbsolute(item.path) && pin !== undefined && pin.sha256 === item.sha256 && pin.sizeBytes === item.sizeBytes, "child runtime file observation is outside its approved manifest");
  };
  for (const [item, rel] of [[rt.pythonExecutable, "bin/python.exe"], [rt.pcbnewModule, "bin/Lib/site-packages/pcbnew.py"], [rt.nativeExtension, "bin/Lib/site-packages/_pcbnew.pyd"]] as const) {
    assert(samePath(item.path, path.join(root, ...rel.split("/"))), "child core module path mismatch"); checkRuntimePin(item);
  }
  assert(samePath(rt.helper.path, helper.path) && canonicalJson(asContent(rt.helper)) === canonicalJson(helper.contentIdentity), "child helper observation differs from host pin");
  const imports = [path.join(bin, "DLLs"), path.join(bin, "Lib"), path.join(bin, "Lib", "site-packages")];
  assert(canonicalJson(rt.importPaths.map(normalized)) === canonicalJson(imports.map(normalized))
    && canonicalJson(rt.initialImportPaths.map(normalized)) === canonicalJson([path.join(bin, "python311.zip"), imports[0]!, imports[1]!, bin].map(normalized))
    && samePath(rt.initialPrefix, bin) && samePath(rt.initialBasePrefix, bin), "child import search escaped isolated runtime");
  const modules = Object.values(rt.loadedPythonModules); assert(modules.length > 0 && modules.length <= 256 && rt.loadedPythonModules.pcbnew && rt.loadedPythonModules._pcbnew, "child Python module inventory is incomplete");
  for (const [name, expected] of [["pcbnew", rt.pcbnewModule], ["_pcbnew", rt.nativeExtension]] as const) {
    const actual = rt.loadedPythonModules[name]!;
    assert(samePath(actual.path, expected.path) && actual.sha256 === expected.sha256 && actual.sizeBytes === expected.sizeBytes, "core Python module name is bound to the wrong runtime file");
  }
  for (const item of modules) {
    checkRuntimePin(item);
    assert(item.origin === null || item.origin === "frozen" || item.origin === "built-in" || samePath(item.origin, item.path), "Python module origin is outside approved runtime");
    assert(item.bytecodeCache === null && (item.bytecodeCachePath === null || within(root, item.bytecodeCachePath) && /\.pyc$/iu.test(item.bytecodeCachePath)), "child read unexpected bytecode");
  }
  assert(setEqual([...new Set(modules.filter(x => /\.py$/iu.test(x.path)).map(x => normalized(x.path)))], manifest.files.filter(x => /\.py$/iu.test(x.path)).map(x => normalized(path.join(root, ...x.path.split("/"))))), "Python source module inventory is incomplete");
  for (const item of rt.bundledNativeDependencies) checkRuntimePin(item);
  assert(setEqual(rt.bundledNativeDependencies.map(x => normalized(x.path)), manifest.files.filter(x => /\.(?:exe|dll|pyd)$/iu.test(x.path)).map(x => normalized(path.join(root, ...x.path.split("/"))))), "native dependency inventory differs from approved closure");
  // Windows may omit an optional platform DLL (observed: windows.storage.dll
  // under the bounded parent). The pinned list is an allowlist, not a request
  // to load unused OS libraries. The copied Python/native closure stays exact.
  const systemDependencies=rt.windowsSystemNativeDependencyPaths.map(normalized),allowedSystemDependencies=new Set(manifest.windowsSystemNativeDependencyPaths.map(normalized));
  assert(new Set(systemDependencies).size===systemDependencies.length && systemDependencies.every(file=>allowedSystemDependencies.has(file))
    && rt.windowsSystemNativeDependencyPaths.every(file => ["System32", "SysWOW64", "WinSxS"].some(dir => within(path.join(systemRoot, dir), file))), "unexpected system native dependency path");
  const items = [...report.zones, ...report.allPads, ...report.allFootprints, ...report.allTracks];
  assert(new Set(items.map(x => x.uuid)).size === items.length, "duplicate native inventory UUID");
  assert(report.inventory.zoneCount === report.zones.length && report.inventory.padCount === report.allPads.length
    && report.inventory.footprintCount === report.allFootprints.length && report.inventory.trackCount === report.allTracks.length, "native inventory counts differ");
  const footprints = new Map(report.allFootprints.map(x => [x.uuid, x]));
  const pads = new Map(report.allPads.map(x => [x.uuid, x])), tracks = new Map(report.allTracks.map(x => [x.uuid, x]));
  for (const pad of report.allPads) assert(footprints.get(pad.footprintUuid)?.reference === pad.reference && new Set(pad.padstackUniqueLayers).size === pad.padstackUniqueLayers.length, "pad parent or padstack inventory differs");
  for (const item of [...report.allPads, ...report.allTracks, ...report.zones]) assert(new Set(item.layers.map(x => x.id)).size === item.layers.length, "duplicate native layer");
  let vertices = 0;
  for (const zone of report.zones) {
    for (const [contacts, inventory, classes] of [[zone.directPads, pads, ["PAD"]], [zone.directTracks, tracks, ["PCB_TRACK", "PCB_ARC"]], [zone.directVias, tracks, ["PCB_VIA"]]] as const) {
      assert(new Set(contacts.map(x => x.uuid)).size === contacts.length, "duplicate direct contact");
      for (const contact of contacts) {
        const actual = inventory.get(contact.uuid);
        assert(actual && (classes as readonly string[]).includes(contact.nativeClass) && ["nativeType", "nativeClass", "netCode", "netName"].every(key => actual[key as keyof typeof actual] === contact[key as keyof typeof contact]), "direct contact differs from complete native inventory");
        assert(contact.netCode === zone.netCode && contact.netName === zone.netName, "direct contact net differs from zone");
      }
    }
    for (const layer of zone.layers) {
      assert(layer.filledSubpolygonCount === layer.subpolygons.length && (layer.hasFilledPolys || layer.subpolygons.length === 0), "filled subpolygon inventory differs");
      const geometries = layer.subpolygons.map((polygon, index) => {
        const geometry = { outline: polygon.outline, holes: polygon.holes };
        vertices += polygon.outline.length + polygon.holes.reduce((count, ring) => count + ring.length, 0);
        assert(polygon.index === index && contentIdentity(canonicalJson(geometry)).digest === polygon.sha256, "native subpolygon geometry hash differs"); return geometry;
      });
      assert(contentIdentity(canonicalJson(geometries)).digest === layer.filledGeometrySha256, "native layer geometry hash differs");
    }
  }
  assert(vertices <= 250000, "native geometry exceeds aggregate vertex limit");
}

/** Host-bound read only; returned reader accepts no paths, pads or model-selected arguments. */
export async function createKicadPlaneContactsReader(options: KicadPlaneContactsOptions): Promise<KicadPlaneContactsReader> {
  const { pcbPath, runtimeRoot, outputRoot } = options;
  const manifestPin = Object.freeze({ path: options.manifest.path, contentIdentity: Object.freeze({ ...options.manifest.contentIdentity }) });
  const helper = Object.freeze({ path: options.helper.path, contentIdentity: Object.freeze({ ...options.helper.contentIdentity }) });
  const expectedSource = Object.freeze({ ...options.expectedSourceIdentity }); contentPin(expectedSource, MAX_FILE);
  assert([pcbPath, runtimeRoot, outputRoot, manifestPin.path, helper.path].every(path.isAbsolute), "paths must be absolute host configuration");
  for (const protectedPath of [runtimeRoot, manifestPin.path, helper.path]) assert(!within(outputRoot, protectedPath) && !within(protectedPath, outputRoot), "private output overlaps protected runtime resources");
  assert(!within(runtimeRoot, pcbPath), "board source overlaps runtime"); await ordinaryChain(outputRoot);
  const outputBinding = await lstat(outputRoot, { bigint: true }); assert(outputBinding.isDirectory(), "output root is not a directory");
  const assertOutputRoot = async () => { await ordinaryChain(outputRoot); const current = await lstat(outputRoot, { bigint: true });
    assert(current.isDirectory() && current.dev === outputBinding.dev && current.ino === outputBinding.ino, "private output directory changed"); };
  const manifestBytes = await pinnedFile(manifestPin.path, manifestPin.contentIdentity, 2 * 1024 * 1024);
  const manifest = manifestSchema.parse(parsePortableJsonBytes(manifestBytes.bytes, { maxBytes: 2 * 1024 * 1024, maxDepth: 12, maxNodes: 20000, maxArrayLength: 2048, maxOwnKeys: 64, maxStringBytes: 32768 }));
  assert(samePath(runtimeRoot, manifest.runtimeRoot) && samePath(helper.path, manifest.helper.path) && canonicalJson(asContent(manifest.helper)) === canonicalJson(helper.contentIdentity), "manifest does not match host runtime/helper pins");
  const systemRoot = options.environment.SYSTEMROOT ?? options.environment.SystemRoot, windir = options.environment.WINDIR ?? options.environment.windir;
  assert(systemRoot !== undefined && windir !== undefined && samePath(systemRoot, windir), "requires matching trusted Windows system roots");
  await ordinaryChain(systemRoot); await ordinaryChain(path.join(systemRoot, "System32"));
  assert(samePath(manifest.environmentOverrides.PATH, path.join(systemRoot, "System32")), "manifest PATH differs from trusted System32");
  const readSource = await createKicadSavedSourceReader({ pcbPath });
  const runner = options.runner ?? runBoundedProcess, termination = options.windowsProcessTreeTermination;
  const verify = async () => { const manifestCapture = await pinnedFile(manifestPin.path, manifestPin.contentIdentity, 2 * 1024 * 1024); const helperCapture = await pinnedFile(helper.path, helper.contentIdentity);
    const closure = await scanRuntime(runtimeRoot, manifest); return { manifestCapture, helperCapture, closure }; };
  await verify();
  let active = false;
  return Object.freeze({ read: async (...arguments_: unknown[]): Promise<KicadPlaneContactsObservation> => {
    assert(arguments_.length === 0, "reader accepts no caller path or pad selectors"); assert(!active, "reader already has an active observation"); active = true;
    try {
      const before = await verify(); await ordinaryChain(pcbPath);
      const sourceStat = await lstat(pcbPath, { bigint: true }); const sourceBefore = (await readSource(() => null)).sourceIdentity;
      assert(canonicalJson(sourceBefore) === canonicalJson(expectedSource), "saved PCB source is stale");
      await assertOutputRoot();
      const directory = await mkdtemp(path.join(outputRoot, "plane-contacts-")); const cwd = path.join(directory, "cwd"), home = path.join(directory, "home"), config = path.join(directory, "config"), temp = path.join(directory, "temp");
      for (const dir of [cwd, home, config, temp, path.join(home, "AppData", "Roaming"), path.join(home, "AppData", "Local")]) await mkdir(dir, { recursive: true });
      await ordinaryChain(directory); await assertOutputRoot();
      const env = Object.freeze({ SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, "System32"), HOME: home, USERPROFILE: home,
        HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/u, ""), HOMEPATH: home.slice(path.parse(home).root.replace(/[\\/]$/u, "").length), APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), KICAD_CONFIG_HOME: config, TEMP: temp, TMP: temp });
      const command = path.join(runtimeRoot, "bin", "python.exe"), args = [...manifest.pythonArgs, helper.path, "--board", pcbPath, "--expected-source-sha256", expectedSource.digest];
      let processResult: Awaited<ReturnType<BoundedProcessRunner>> | undefined;
      let processFailure: ReturnType<typeof captureKicadStartupCause> | undefined;
      try { processResult = await runner({ command, args, cwd, env, timeoutMs: 15000, maxOutputBytes: MAX_OUTPUT,
        ...(termination === undefined ? {} : { windowsProcessTreeTermination: termination }) }); } catch (error) { processFailure = captureKicadStartupCause(error); }
      // Preserve an already failed native outcome before any later filesystem
      // recheck can fail. The trusted bounded process result remains private.
      const invalidProcessOutcome = processResult !== undefined && (processResult.exitCode !== 0 || processResult.stderr !== ""
        || "signal" in processResult && processResult.signal !== null && processResult.signal !== undefined
        || !Number.isFinite(processResult.durationMs) || processResult.durationMs < 0 || processResult.durationMs > 15000
        || Buffer.byteLength(processResult.stdout,"utf8") > MAX_OUTPUT)
        ? Object.freeze({exitCode:processResult.exitCode,durationMs:processResult.durationMs,
          signal:"signal" in processResult?processResult.signal:null,
          stdout:processResult.stdout.slice(0,MAX_OUTPUT),stderr:processResult.stderr.slice(0,MAX_OUTPUT)}) : undefined;
      let after: Awaited<ReturnType<typeof verify>>, sourceAfter: ContentIdentity;
      try {
        after = await verify(); sourceAfter = (await readSource(() => null)).sourceIdentity;
        assert(sameStat(sourceStat, await lstat(pcbPath, { bigint: true })) && canonicalJson(sourceBefore) === canonicalJson(sourceAfter), "saved PCB source changed during observation");
        assert(sameStat(before.manifestCapture.stat, after.manifestCapture.stat) && sameStat(before.helperCapture.stat, after.helperCapture.stat)
          && [...before.closure.witnesses].every(([name, stat]) => after.closure.witnesses.has(name) && sameStat(stat, after.closure.witnesses.get(name)!)), "runtime/helper/manifest changed during observation");
      } catch (verificationError) {
        if (processFailure !== undefined || invalidProcessOutcome !== undefined) throw new Error("Native plane contacts: helper process failed and post-execution verification failed", {
          cause: Object.freeze({ processFailure:processFailure??null,processOutcome:invalidProcessOutcome??null,verificationFailure: captureKicadStartupCause(verificationError) }) });
        throw verificationError;
      }
      if (processFailure !== undefined || processResult === undefined) throw new Error("Native plane contacts: helper process failed or did not settle safely", {
        cause: Object.freeze({ processFailure: processFailure ?? null, verificationFailure: null }) });
      if(invalidProcessOutcome!==undefined)throw new Error("Native plane contacts: helper process exit/signal/stderr or deadline is invalid",{
        cause:Object.freeze({processOutcome:invalidProcessOutcome,verificationFailure:null})});
      assert(processResult.exitCode === 0 && processResult.stderr === "" && !("signal" in processResult && processResult.signal !== null && processResult.signal !== undefined), "helper process exit/signal/stderr is invalid");
      assert(processResult.command === command && canonicalJson(processResult.args) === canonicalJson(args) && processResult.cwd === cwd, "process result does not match fixed invocation");
      assert(Number.isFinite(processResult.durationMs) && processResult.durationMs >= 0 && processResult.durationMs <= 15000, "helper exceeded its process deadline");
      const raw = Buffer.from(processResult.stdout, "utf8"); assert(raw.length <= MAX_OUTPUT, "helper output exceeds byte bound");
      // Preserve exact native output before decoding/applicability checks. A
      // rejected observation remains diagnostic data and receives no brand.
      const rawPath = path.join(directory, "raw-output.json"); await assertOutputRoot(); await writeFile(rawPath, raw, { flag: "wx", mode: 0o600 });
      await pinnedFile(rawPath, contentIdentity(raw), MAX_OUTPUT);
      const report = kicadPlaneContactsNativeReportSchema.parse(parsePortableJsonBytes(raw, { maxBytes: MAX_OUTPUT, maxDepth: 20, maxNodes: 500000, maxArrayLength: 200000, maxOwnKeys: 512, maxStringBytes: 32768 }));
      validateNativeReport(report, manifest, runtimeRoot, systemRoot, helper, sourceBefore, pcbPath);
      const observation = hardenPortableValue({ schemaVersion: "evleda.kicad-plane-contacts-observation.v1", sourceBefore, sourceAfter, sourceUnchanged: true, report,
        runtime: { manifestIdentity: manifestPin.contentIdentity, helperIdentity: helper.contentIdentity, treeIdentity: after.closure.identity },
        limitations: { foreignNetGeometricOverlaps: "not_assessed_by_direct_neighbors", contactScope: "aggregate-native-subpolygons", savedFillFreshness: "not_established" },
        artifacts: { rawOutput: { path: rawPath, identity: contentIdentity(raw) } } }, { maxBytes: 16 * 1024 * 1024, maxDepth: 24, maxNodes: 500000, maxArrayLength: 200000, maxOwnKeys: 512, maxStringBytes: 32768 }) as KicadPlaneContactsObservation;
      observations.add(observation); return observation;
    } finally { active = false; }
  } });
}

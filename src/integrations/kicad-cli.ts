import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, opendir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { createFreshSchematicStrokeStyleEvidence, FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE, type FreshSchematicStrokeStyleCapture, type FreshSchematicStrokeStyleEvidence } from "../harness/fresh-schematic-stroke-style.js";

import {
  type BoundedProcessResult,
  type BoundedProcessRunner,
  runBoundedProcess,
} from "./bounded-process.js";
import {
  assertPathWithin,
  assertDisjointDirectories,
  isPathWithin,
  prepareEmptyOutputDirectory,
  resolveConfinedExistingFile,
  resolveExistingDirectory,
  resolveExistingFile,
} from "./path-boundary.js";
import {
  buildKicadCapabilityByteEvidenceV1,
  buildKicadNativeToolIdentityV1,
  PORTABLE_KICAD_RUNTIME_CAPABILITY_PROBES_V1,
  type KicadCapabilityByteEvidenceV1,
} from "./portable-kicad-runtime.js";
import {
  validateToolContentIdentityV1,
  validateCanonicalIdentity,
  parsePortableJsonBytes,
  type ToolContentIdentityV1,
} from "../core/portable-artifact.js";

export const DEFAULT_KICAD_10_CLI_PATH = "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe";
export const KICAD_DESIGN_VIOLATIONS_EXIT_CODE = 5;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_REPORT_BYTES = 32 * 1024 * 1024;
// .kicad_prl is a per-user local-preferences file that headless KiCad may create
// even for read-only exports. It is deliberately excluded from design-source
// preservation; project, schematic, PCB, rules, libraries, and jobsets remain protected.
const NATIVE_SOURCE_PATTERN =
  /\.kicad_(?:pro|sch|pcb|dru|wks|sym|mod|jobset|dbl)$/i;
const NATIVE_SOURCE_BASENAMES = new Set(["sym-lib-table", "fp-lib-table"]);
const ALLOWED_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "KICAD_CONFIG_HOME",
  "KICAD10_SYMBOL_DIR",
  "KICAD10_FOOTPRINT_DIR",
  "KICAD10_3DMODEL_DIR",
  "KICAD10_TEMPLATE_DIR",
  "KICAD10_USER_TEMPLATE_DIR",
] as const);

const CAPABILITY_PROBES = Object.freeze([
  ...PORTABLE_KICAD_RUNTIME_CAPABILITY_PROBES_V1,
  {
    args: ["sch", "export", "bom", "--help"],
    required: ["--output", "--fields", "--labels", "--group-by", "--sort-field"],
  },
  {
    args: ["sch", "export", "svg", "--help"],
    required: ["--output", "--black-and-white", "--no-background-color"],
  },
  {
    args: ["pcb", "export", "gerbers", "--help"],
    required: ["--output", "--layers", "--precision", "--no-protel-ext"],
  },
  {
    args: ["pcb", "export", "drill", "--help"],
    required: [
      "--output",
      "--format",
      "--drill-origin",
      "--excellon-units",
      "--generate-report",
    ],
  },
  {
    args: ["pcb", "export", "pos", "--help"],
    required: ["--output", "--side", "--format", "--units", "--exclude-dnp"],
  },
  {
    args: ["pcb", "render", "--help"],
    required: ["--output", "--width", "--height", "--side", "--quality", "--preset"],
  },
] as const);

export interface KicadCliAdapterOptions {
  /** Source workspace containing `projectRoot`; command probes and cwd remain confined here. */
  readonly workspaceRoot: string;
  readonly projectRoot: string;
  /** Optional independent, narrow root for generated artifacts. Defaults to `workspaceRoot`. */
  readonly outputRoot?: string;
  /** Optional server-owned content pin checked before any executable probe. */
  readonly expectedExecutableIdentity?: Readonly<{ readonly sha256: string; readonly sizeBytes: number }>;
  readonly executablePath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxReportBytes?: number;
  readonly runner?: BoundedProcessRunner;
  readonly signal?: AbortSignal;
}

export interface KicadExecutableIdentity {
  readonly kind: "kicad-cli";
  readonly path: string;
  readonly version: string;
  readonly commit: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly capabilityHelpSha256: string;
  readonly confirmedCapabilities: readonly string[];
}

/**
 * Private discovery material used to pin the portable runtime resolver.
 * The bytes are captured observations, not an authenticity or safety claim.
 */
export interface KicadPortableRuntimeToolEvidenceV1 {
  readonly authority: "observed-not-authenticated";
  readonly tool: ToolContentIdentityV1;
  readonly helpCaptureBytes: Uint8Array;
  readonly capabilityManifestBytes: Uint8Array;
}

export interface KicadCliInvocationEvidence {
  readonly executable: KicadExecutableIdentity;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly startedAt: string;
}

export interface KicadNativeCheck {
  readonly kind: "erc" | "drc";
  readonly status: "clean" | "violations";
  readonly reportPath: string;
  readonly violationCount: number;
  readonly schematicParityCount: number;
  readonly report: Readonly<Record<string, unknown>>;
  readonly invocation: KicadCliInvocationEvidence;
}

export interface KicadCheckResult {
  readonly classification: "candidate-validation";
  readonly releaseAuthorized: false;
  readonly executable: KicadExecutableIdentity;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly erc: KicadNativeCheck;
  readonly drc: KicadNativeCheck;
  readonly clean: boolean;
}

export interface KicadCandidateExportOptions {
  readonly schematicPath: string;
  readonly pcbPath: string;
  readonly outputDirectory: string;
  readonly signal?: AbortSignal;
}

export interface KicadCheckOptions extends KicadCandidateExportOptions {}

export interface KicadCandidateArtifact {
  readonly path: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface KicadCandidateExportResult {
  readonly classification: "candidate";
  readonly releaseAuthorized: false;
  readonly executable: KicadExecutableIdentity;
  readonly outputDirectory: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly gerberLayers: readonly string[];
  readonly invocations: readonly KicadCliInvocationEvidence[];
  readonly artifacts: readonly KicadCandidateArtifact[];
}

/** Strictly display-oriented KiCad output. It intentionally excludes fabrication files. */
export interface KicadPreviewExportOptions extends KicadCandidateExportOptions {}

export interface KicadPreviewExportResult {
  readonly classification: "candidate-preview";
  readonly releaseAuthorized: false;
  readonly executable: KicadExecutableIdentity;
  readonly outputDirectory: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly invocations: readonly KicadCliInvocationEvidence[];
  readonly artifacts: readonly KicadCandidateArtifact[];
}

export interface KicadNativeInspectionOptions extends KicadCandidateExportOptions {}

export interface KicadSchematicNetlistOptions extends KicadCandidateExportOptions {}

export interface KicadSchematicSvgOptions extends KicadCandidateExportOptions {}

export interface KicadPcbSvgOptions extends KicadCandidateExportOptions {
  readonly view: "top" | "assembly";
}
export interface KicadPcbSvgResult {
  readonly classification: "candidate-preview";
  readonly releaseAuthorized: false;
  readonly executable: KicadExecutableIdentity;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly invocation: KicadCliInvocationEvidence;
  readonly pcbSvg: KicadCandidateArtifact;
  readonly source: string;
  readonly view: "top" | "assembly";
  readonly layers: readonly string[];
}

export const KICAD_SCHEMATIC_CONFIGURATION_TREE_SCHEMA_VERSION = "evleda.kicad-schematic-configuration-tree.v1" as const;
export const KICAD_SCHEMATIC_CONFIGURATION_LIMITS = Object.freeze({ maximumFiles: 128, maximumDirectories: 64, maximumDepth: 8, maximumFileBytes: 4 * 1024 * 1024, maximumTotalBytes: 8 * 1024 * 1024 });
export interface KicadSchematicConfigurationSnapshot {
  /** Private physical location; excluded from the path-free tree identity. */
  readonly configHome: string;
  readonly identity: CanonicalIdentity;
  readonly files: readonly Readonly<{ relativePath: string; identity: ContentIdentity }>[];
  readonly directories: readonly string[];
  readonly applicationConfig: Readonly<{ relativePath: "10.0/eeschema.json"; source: string; identity: ContentIdentity }>;
}
export interface KicadSchematicSvgStrokeStyleOptions extends KicadSchematicSvgOptions {
  readonly configuration: Readonly<{ configHome: string; cacheHome: string; expectedTreeIdentity: CanonicalIdentity }>;
}

export interface KicadSchematicSourceIdentities {
  readonly schematic: ContentIdentity;
  readonly pcb: ContentIdentity;
  readonly projectSettings: ContentIdentity;
}

/** Exact native SVG bytes and their unchanged design inputs; no readability claim. */
export interface KicadSchematicSvgResult {
  readonly classification: "candidate-validation";
  readonly releaseAuthorized: false;
  readonly executable: KicadExecutableIdentity;
  readonly outputDirectory: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly sourceIdentities: KicadSchematicSourceIdentities;
  readonly invocation: KicadCliInvocationEvidence;
  readonly schematicSvg: KicadCandidateArtifact;
  readonly source: string;
  /** Host-only in-process capability; absent on historical ordinary SVG exports. */
  readonly strokeStyleEvidence?: FreshSchematicStrokeStyleEvidence;
}

export interface KicadSchematicSvgStrokeStyleResult extends KicadSchematicSvgResult {
  readonly strokeStyleEvidence: FreshSchematicStrokeStyleEvidence;
  /** Private raw audit inputs. The nested render is the original style-free SVG capture. */
  readonly strokeStyleCapture: FreshSchematicStrokeStyleCapture;
  /** KiCad may create per-user project preferences; these are not protected design sources. */
  readonly localPreferences: Readonly<{ relativePath: string; before: ContentIdentity | null; after: ContentIdentity | null }>;
}

export interface KicadSchematicNetlistResult {
  readonly classification: "candidate-validation";
  readonly releaseAuthorized: false;
  readonly executable: KicadExecutableIdentity;
  readonly outputDirectory: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly invocation: KicadCliInvocationEvidence;
  readonly schematicNetlist: KicadCandidateArtifact;
  readonly source: string;
}

/**
 * Source-preserving, CLI-native machine-readable views used by higher-level
 * critics. These are candidate validation artifacts, never release evidence.
 */
export interface KicadNativeInspectionResult {
  readonly classification: "candidate-validation";
  readonly releaseAuthorized: false;
  readonly executable: KicadExecutableIdentity;
  readonly outputDirectory: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly invocations: readonly KicadCliInvocationEvidence[];
  readonly schematicNetlist: KicadCandidateArtifact;
  readonly boardStatistics: KicadCandidateArtifact;
  readonly boardNetlist: KicadCandidateArtifact;
}

export class KicadCliError extends Error {
  override readonly name: string = "KicadCliError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class KicadSchematicConfigurationError extends KicadCliError {
  override readonly name = "KicadSchematicConfigurationError";
  constructor(readonly code: "INVALID_CONFIGURATION" | "CONFIGURATION_DRIFT", message: string, options?: ErrorOptions) { super(message, options); }
}

export class KicadCliInvocationError extends KicadCliError {
  override readonly name = "KicadCliInvocationError";
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, result: BoundedProcessResult) {
    super(message);
    this.args = [...result.args];
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export class KicadSourceMutationError extends KicadCliError {
  override readonly name = "KicadSourceMutationError";
  readonly changedPaths: readonly string[];

  constructor(changedPaths: readonly string[], options?: ErrorOptions) {
    super(
      `KiCad changed protected native source files: ${changedPaths.join(", ")}`,
      options,
    );
    this.changedPaths = [...changedPaths];
  }
}

interface ValidatedDesignInputs {
  readonly schematicPath: string;
  readonly pcbPath: string;
  readonly projectFilePath: string;
  readonly designDirectory: string;
  readonly designName: string;
}

interface ParsedCheckReport {
  readonly report: Readonly<Record<string, unknown>>;
  readonly violationCount: number;
  readonly schematicParityCount: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new KicadCliError(`${label} must be a positive integer.`);
  }
  return value;
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  requestedKey: string,
): string | undefined {
  const direct = environment[requestedKey];
  if (direct !== undefined) return direct;
  if (process.platform !== "win32") return undefined;
  return Object.entries(environment).find(
    ([key]) => key.toLocaleLowerCase("en-US") === requestedKey.toLocaleLowerCase("en-US"),
  )?.[1];
}

/**
 * Resolve the configured CLI path without touching the filesystem.
 *
 * An explicit constructor option remains authoritative. Otherwise the same
 * EVLEDA_KICAD_CLI override is honored by direct adapter users, higher-level
 * backends, and integration-test discovery before probing the system and
 * per-user Windows installation paths.
 */
export function configuredKicadCliPath(
  executablePath?: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = executablePath ?? environmentValue(environment, "EVLEDA_KICAD_CLI");
  if (explicit !== undefined) return explicit;
  if (existsSync(DEFAULT_KICAD_10_CLI_PATH)) return DEFAULT_KICAD_10_CLI_PATH;
  const localAppData = environmentValue(environment, "LOCALAPPDATA");
  if (localAppData !== undefined) {
    const perUserPath = path.join(
      localAppData,
      "Programs",
      "KiCad",
      "10.0",
      "bin",
      "kicad-cli.exe",
    );
    if (existsSync(perUserPath)) return perUserPath;
  }
  return DEFAULT_KICAD_10_CLI_PATH;
}

function buildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    const value = environmentValue(source, key);
    if (value !== undefined && value !== "") selected[key] = value;
  }
  selected.NO_COLOR = "1";
  selected.LANG = "C";
  selected.LANGUAGE = "C";
  selected.LC_ALL = "C";
  return Object.freeze(selected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezePublicResult<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezePublicResult(child);
  }
  return Object.freeze(value);
}

function immutableExecutableIdentitySnapshot(
  identity: KicadExecutableIdentity,
): KicadExecutableIdentity {
  return Object.freeze({
    kind: "kicad-cli",
    path: identity.path,
    version: identity.version,
    commit: identity.commit,
    sha256: identity.sha256,
    sizeBytes: identity.sizeBytes,
    capabilityHelpSha256: identity.capabilityHelpSha256,
    confirmedCapabilities: Object.freeze([...identity.confirmedCapabilities]),
  });
}

function detachedExecutableIdentity(
  identity: KicadExecutableIdentity,
): KicadExecutableIdentity {
  return immutableExecutableIdentitySnapshot(identity);
}

function detachedPortableRuntimeToolEvidence(
  toolIdentity: ToolContentIdentityV1,
  capabilityEvidence: KicadCapabilityByteEvidenceV1,
): KicadPortableRuntimeToolEvidenceV1 {
  const tool = validateToolContentIdentityV1(toolIdentity, "$kicadToolEvidence/tool");
  const privateHelpCaptureBytes = Buffer.from(capabilityEvidence.helpCaptureBytes);
  const privateCapabilityManifestBytes = Buffer.from(
    capabilityEvidence.capabilityManifestBytes,
  );
  return Object.freeze({
    authority: "observed-not-authenticated",
    tool,
    get helpCaptureBytes(): Uint8Array {
      return Buffer.from(privateHelpCaptureBytes);
    },
    get capabilityManifestBytes(): Uint8Array {
      return Buffer.from(privateCapabilityManifestBytes);
    },
  });
}

function isNativeSourceName(fileName: string): boolean {
  return (
    NATIVE_SOURCE_PATTERN.test(fileName) ||
    NATIVE_SOURCE_BASENAMES.has(fileName.toLocaleLowerCase("en-US"))
  );
}

function asRecordArray(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    throw new KicadCliError(`${label} must be an array of JSON objects.`);
  }
  return value;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function readBoundedText(filePath: string, maxBytes: number, label: string): Promise<string> {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new KicadCliError(`${label} must be a regular, non-symlink file.`);
  }
  if (metadata.size <= 0 || metadata.size > maxBytes) {
    throw new KicadCliError(`${label} has an invalid size of ${metadata.size} bytes.`);
  }
  return await readFile(filePath, "utf8");
}

async function collectNativeSources(
  projectRoot: string,
  maxEntries = 10_000,
): Promise<ReadonlyMap<string, string>> {
  const sourceFiles: string[] = [];
  const pending = [projectRoot];
  let entriesSeen = 0;

  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > maxEntries) {
        throw new KicadCliError("KiCad source snapshot exceeded its entry limit.");
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (isNativeSourceName(entry.name)) {
          throw new KicadCliError(`Protected KiCad source is a symbolic link: ${entryPath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && isNativeSourceName(entry.name)) {
        sourceFiles.push(entryPath);
      }
    }
  }

  sourceFiles.sort((left, right) => left.localeCompare(right, "en-US"));
  const snapshot = new Map<string, string>();
  for (const sourceFile of sourceFiles) snapshot.set(sourceFile, await sha256File(sourceFile));
  return snapshot;
}

function changedSourcePaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  projectRoot: string,
): readonly string[] {
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  return [...allPaths]
    .filter((sourcePath) => before.get(sourcePath) !== after.get(sourcePath))
    .map((sourcePath) => path.relative(projectRoot, sourcePath).split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en-US"));
}

function snapshotAsRecord(
  snapshot: ReadonlyMap<string, string>,
  projectRoot: string,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    [...snapshot.entries()].map(([sourcePath, hash]) => [
      path.relative(projectRoot, sourcePath).split(path.sep).join("/"),
      hash,
    ]),
  ));
}

function invocationEvidence(
  identity: KicadExecutableIdentity,
  result: BoundedProcessResult,
): KicadCliInvocationEvidence {
  return Object.freeze({
    executable: detachedExecutableIdentity(identity),
    command: result.command,
    args: Object.freeze([...result.args]),
    cwd: result.cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
  });
}

function assertSuccessful(result: BoundedProcessResult, purpose: string): void {
  if (result.exitCode !== 0) {
    throw new KicadCliInvocationError(
      `${purpose} failed with KiCad CLI exit code ${result.exitCode}.`,
      result,
    );
  }
}

function parseVersion(stdout: string): string {
  const version = stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!/^10\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new KicadCliError(`Expected KiCad 10.x CLI, received version '${version || "empty"}'.`);
  }
  return version;
}

async function validateDesignInputs(
  projectRoot: string,
  schematicPath: string,
  pcbPath: string,
): Promise<ValidatedDesignInputs> {
  const schematic = await resolveConfinedExistingFile(
    projectRoot,
    projectRoot,
    schematicPath,
    "KiCad schematic",
  );
  const pcb = await resolveConfinedExistingFile(projectRoot, projectRoot, pcbPath, "KiCad PCB");
  if (path.extname(schematic).toLocaleLowerCase("en-US") !== ".kicad_sch") {
    throw new KicadCliError("Schematic input must have the .kicad_sch extension.");
  }
  if (path.extname(pcb).toLocaleLowerCase("en-US") !== ".kicad_pcb") {
    throw new KicadCliError("PCB input must have the .kicad_pcb extension.");
  }

  const schematicName = path.basename(schematic, ".kicad_sch");
  const pcbName = path.basename(pcb, ".kicad_pcb");
  if (
    schematicName !== pcbName ||
    path.dirname(schematic).toLocaleLowerCase("en-US") !==
      path.dirname(pcb).toLocaleLowerCase("en-US")
  ) {
    throw new KicadCliError(
      "Schematic parity requires matching .kicad_sch/.kicad_pcb stems in one directory.",
    );
  }
  const projectFile = await resolveConfinedExistingFile(
    projectRoot,
    path.dirname(schematic),
    `${schematicName}.kicad_pro`,
    "KiCad project file",
  );
  return {
    schematicPath: schematic,
    pcbPath: pcb,
    projectFilePath: projectFile,
    designDirectory: path.dirname(schematic),
    designName: schematicName,
  };
}

function extractGerberLayers(boardSource: string): readonly string[] {
  const numberedLayer = /^\s*\(\s*\d+\s+"([^"]+)"\s+[^)]*\)\s*$/gm;
  const layers: string[] = [];
  for (const match of boardSource.matchAll(numberedLayer)) {
    const layer = match[1];
    if (layer !== undefined && !layers.includes(layer)) layers.push(layer);
  }
  const copper = layers.filter((layer) => /^(?:F|B|In\d+)\.Cu$/.test(layer));
  const fabrication = [
    "F.Paste",
    "B.Paste",
    "F.SilkS",
    "B.SilkS",
    "F.Mask",
    "B.Mask",
    "Edge.Cuts",
  ].filter((layer) => layers.includes(layer));
  const selected = [...copper, ...fabrication];
  for (const required of ["F.Cu", "B.Cu", "Edge.Cuts"]) {
    if (!selected.includes(required)) {
      throw new KicadCliError(`PCB layer table is missing required Gerber layer '${required}'.`);
    }
  }
  return Object.freeze(selected);
}

async function collectArtifacts(outputRoot: string): Promise<readonly KicadCandidateArtifact[]> {
  const result: KicadCandidateArtifact[] = [];
  const pending = [outputRoot];
  let entriesSeen = 0;
  let totalSizeBytes = 0;

  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > 10_000) {
        throw new KicadCliError("KiCad artifact collection exceeded its entry limit.");
      }
      const artifactPath = path.join(directory, entry.name);
      assertPathWithin(outputRoot, artifactPath, "KiCad artifact", false);
      const metadata = await lstat(artifactPath);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        throw new KicadCliError(`KiCad output contains a forbidden symbolic link: ${artifactPath}`);
      }
      const canonicalPath = await realpath(artifactPath);
      assertPathWithin(outputRoot, canonicalPath, "KiCad artifact", false);
      if (metadata.isDirectory()) {
        pending.push(canonicalPath);
      } else if (metadata.isFile()) {
        if (!entry.isFile() || metadata.nlink !== 1) {
          throw new KicadCliError(`KiCad output is not a single-link ordinary file: ${artifactPath}`);
        }
        if (metadata.size <= 0 || metadata.size > DEFAULT_MAX_REPORT_BYTES) {
          throw new KicadCliError(`KiCad emitted an empty artifact: ${artifactPath}`);
        }
        totalSizeBytes += metadata.size;
        if (totalSizeBytes > DEFAULT_MAX_REPORT_BYTES * 16) {
          throw new KicadCliError("KiCad artifact collection exceeded its aggregate size limit.");
        }
        const digest = await sha256File(canonicalPath);
        const after = await stat(canonicalPath);
        if (
          after.size !== metadata.size ||
          after.mtimeMs !== metadata.mtimeMs ||
          after.nlink !== 1
        ) {
          throw new KicadCliError(`KiCad artifact changed while it was being captured: ${artifactPath}`);
        }
        result.push(Object.freeze({
          path: canonicalPath,
          relativePath: path.relative(outputRoot, canonicalPath).split(path.sep).join("/"),
          sizeBytes: metadata.size,
          sha256: digest,
        }));
      } else {
        throw new KicadCliError(`KiCad output is not an ordinary file or directory: ${artifactPath}`);
      }
    }
  }
  result.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en-US"));
  return Object.freeze(result);
}

function assertRequiredArtifacts(artifacts: readonly KicadCandidateArtifact[]): void {
  const names = new Set(artifacts.map((artifact) => artifact.relativePath));
  const exact = [
    "bom.csv",
    "netlist.kicad_net",
    "positions.csv",
    "drill/drill-report.rpt",
    "renders/board-top.png",
    "renders/board-bottom.png",
  ];
  for (const required of exact) {
    if (!names.has(required)) throw new KicadCliError(`Required KiCad artifact is missing: ${required}`);
  }
  const groups = [
    { prefix: "schematic/", extension: ".svg", label: "schematic SVG" },
    { prefix: "gerbers/", extension: ".gbr", label: "Gerber" },
    { prefix: "drill/", extension: ".drl", label: "drill" },
  ];
  for (const group of groups) {
    if (
      !artifacts.some(
        (artifact) =>
          artifact.relativePath.startsWith(group.prefix) &&
          artifact.relativePath.toLocaleLowerCase("en-US").endsWith(group.extension),
      )
    ) {
      throw new KicadCliError(`Required ${group.label} artifacts are missing.`);
    }
  }
}

function assertPreviewArtifacts(artifacts: readonly KicadCandidateArtifact[]): void {
  const names = artifacts.map((artifact) => artifact.relativePath);
  const expected = new Set(["renders/board-bottom.png", "renders/board-top.png"]);
  const schematic = names.filter((name) => name.startsWith("schematic/") && name.endsWith(".svg"));
  if (schematic.length !== 1) {
    throw new KicadCliError("KiCad preview must contain exactly one schematic SVG.");
  }
  expected.add(schematic[0]!);
  if (names.length !== expected.size || names.some((name) => !expected.has(name))) {
    throw new KicadCliError("KiCad preview emitted a non-preview artifact.");
  }
}

const samePhysicalPath = (left: string, right: string): boolean => process.platform === "win32"
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
type ConfigurationPhysicalIdentity = Readonly<{ relativePath: string; kind: "file" | "directory"; dev: string; ino: string }>;
interface CapturedSchematicConfiguration { readonly snapshot: KicadSchematicConfigurationSnapshot; readonly physical: readonly ConfigurationPhysicalIdentity[] }
const physicalIdentity = (relativePath: string, kind: "file" | "directory", metadata: { dev: bigint; ino: bigint }): ConfigurationPhysicalIdentity =>
  Object.freeze({ relativePath, kind, dev: metadata.dev.toString(), ino: metadata.ino.toString() });

async function captureOrdinaryConfigurationFile(filePath: string, maximumBytes: number): Promise<Readonly<{ bytes: Buffer; identity: ContentIdentity; physical: ConfigurationPhysicalIdentity }>> {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumBytes)) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Schematic configuration must contain bounded ordinary nonlinked files.");
  const bytes = await readFile(filePath); const after = await lstat(filePath, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== after.size) throw new KicadSchematicConfigurationError("CONFIGURATION_DRIFT", "Schematic configuration changed during exact-byte capture.");
  return Object.freeze({ bytes, identity: contentIdentity(bytes), physical: physicalIdentity(filePath, "file", after) });
}

// Cache contents are mutable native scratch, but every existing descendant must
// remain private ordinary storage. Inspect metadata only, including empty files
// and native dot/space names; configuration's exact-content rules do not apply.
async function validateSchematicCacheTree(cacheHome: string): Promise<void> {
  const maximumEntries = 4096; const maximumDepth = 32;
  let entries = 0;
  const visit = async (entryPath: string, depth: number): Promise<void> => {
    if (++entries > maximumEntries || depth > maximumDepth) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Schematic cache traversal bounds were exceeded.");
    const before = await lstat(entryPath, { bigint: true });
    if (before.isSymbolicLink() || (!before.isDirectory() && (!before.isFile() || before.nlink !== 1n)) || !samePhysicalPath(await realpath(entryPath), entryPath)) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Schematic cache must contain only ordinary nonlinked files and directories.");
    if (before.isDirectory()) {
      const directory = await opendir(entryPath);
      for await (const child of directory) await visit(path.join(entryPath, child.name), depth + 1);
    }
    const after = await lstat(entryPath, { bigint: true });
    if (after.isSymbolicLink() || after.isDirectory() !== before.isDirectory() || after.isFile() !== before.isFile() || (after.isFile() && after.nlink !== 1n) || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !samePhysicalPath(await realpath(entryPath), entryPath)) throw new KicadSchematicConfigurationError("CONFIGURATION_DRIFT", "Schematic cache ownership changed during validation.");
  };
  await visit(cacheHome, 0);
}

async function captureConfigurationTree(configHome: string): Promise<CapturedSchematicConfiguration> {
  const limits = KICAD_SCHEMATIC_CONFIGURATION_LIMITS;
  const files: { relativePath: string; identity: ContentIdentity }[] = []; const directories: string[] = []; const physical: ConfigurationPhysicalIdentity[] = [];
  let totalBytes = 0; let applicationConfig: KicadSchematicConfigurationSnapshot["applicationConfig"] | undefined;
  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > limits.maximumDepth || directories.length >= limits.maximumDirectories) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Schematic configuration directory bounds were exceeded.");
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !samePhysicalPath(await realpath(directory), directory)) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Schematic configuration directories must not resolve through links.");
    directories.push(relative); physical.push(physicalIdentity(relative, "directory", before));
    const entries = (await readdir(directory)).sort();
    for (const name of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Schematic configuration has an unsupported path component.");
      const child = path.join(directory, name); const childRelative = relative === "." ? name : `${relative}/${name}`; const metadata = await lstat(child, { bigint: true });
      if (metadata.isSymbolicLink()) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Schematic configuration contains a link.");
      if (metadata.isDirectory()) { await visit(child, childRelative, depth + 1); continue; }
      if (files.length >= limits.maximumFiles) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Schematic configuration file count was exceeded.");
      const captured = await captureOrdinaryConfigurationFile(child, limits.maximumFileBytes); totalBytes += captured.bytes.length;
      if (totalBytes > limits.maximumTotalBytes) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Schematic configuration byte limit was exceeded.");
      files.push({ relativePath: childRelative, identity: captured.identity }); physical.push({ ...captured.physical, relativePath: childRelative });
      if (childRelative === "10.0/eeschema.json") {
        let source: string; try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(captured.bytes); }
        catch { throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Owned eeschema configuration is not exact UTF-8."); }
        try {
          const parsed = parsePortableJsonBytes(captured.bytes, { maxBytes: limits.maximumFileBytes, maxDepth: 64, maxNodes: 200_000 });
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a configuration object.");
        } catch (error) { throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Owned eeschema configuration is not a bounded JSON object.", { cause: error }); }
        applicationConfig = { relativePath: "10.0/eeschema.json", source, identity: captured.identity };
      }
    }
    const after = await lstat(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || canonicalJson((await readdir(directory)).sort()) !== canonicalJson(entries)) throw new KicadSchematicConfigurationError("CONFIGURATION_DRIFT", "Schematic configuration tree changed during capture.");
  };
  await visit(configHome, ".", 0);
  if (applicationConfig === undefined) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Owned schematic configuration requires 10.0/eeschema.json.");
  files.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0); directories.sort(); physical.sort((a, b) => `${a.relativePath}:${a.kind}` < `${b.relativePath}:${b.kind}` ? -1 : 1);
  const payload = { schemaVersion: KICAD_SCHEMATIC_CONFIGURATION_TREE_SCHEMA_VERSION, files, directories };
  return deepFreezePublicResult({ snapshot: { configHome, identity: canonicalIdentity(payload, payload.schemaVersion), files, directories, applicationConfig }, physical });
}

export class KicadCliAdapter {
  readonly #workspaceRoot: string;
  readonly #outputRoot: string;
  readonly #projectRoot: string;
  readonly #executablePath: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #maxReportBytes: number;
  readonly #runner: BoundedProcessRunner;
  readonly #identity: KicadExecutableIdentity;
  readonly #portableToolIdentity: ToolContentIdentityV1;
  readonly #portableCapabilityEvidence: KicadCapabilityByteEvidenceV1;
  readonly #sourceBaseline: ReadonlyMap<string, string>;

  private constructor(parameters: {
    workspaceRoot: string;
    outputRoot: string;
    projectRoot: string;
    executablePath: string;
    environment: Readonly<Record<string, string>>;
    timeoutMs: number;
    maxOutputBytes: number;
    maxReportBytes: number;
    runner: BoundedProcessRunner;
    identity: KicadExecutableIdentity;
    portableToolIdentity: ToolContentIdentityV1;
    portableCapabilityEvidence: KicadCapabilityByteEvidenceV1;
    sourceBaseline: ReadonlyMap<string, string>;
  }) {
    this.#workspaceRoot = parameters.workspaceRoot;
    this.#outputRoot = parameters.outputRoot;
    this.#projectRoot = parameters.projectRoot;
    this.#executablePath = parameters.executablePath;
    this.#environment = Object.freeze({ ...parameters.environment });
    this.#timeoutMs = parameters.timeoutMs;
    this.#maxOutputBytes = parameters.maxOutputBytes;
    this.#maxReportBytes = parameters.maxReportBytes;
    this.#runner = parameters.runner;
    this.#identity = immutableExecutableIdentitySnapshot(parameters.identity);
    this.#portableToolIdentity = validateToolContentIdentityV1(
      parameters.portableToolIdentity,
      "$kicadAdapter/portableToolIdentity",
    );
    this.#portableCapabilityEvidence = parameters.portableCapabilityEvidence;
    this.#sourceBaseline = new Map(parameters.sourceBaseline);
  }

  static async create(options: KicadCliAdapterOptions): Promise<KicadCliAdapter> {
    const workspaceRoot = await resolveExistingDirectory(options.workspaceRoot, "KiCad workspace root");
    const projectRoot = await resolveExistingDirectory(options.projectRoot, "KiCad project root");
    assertPathWithin(workspaceRoot, projectRoot, "KiCad project root", true);
    const outputRoot = options.outputRoot === undefined
      ? workspaceRoot
      : await resolveExistingDirectory(options.outputRoot, "KiCad output root");
    const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "KiCad CLI timeout");
    const maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "KiCad CLI output limit",
    );
    const maxReportBytes = positiveInteger(
      options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES,
      "KiCad report limit",
    );
    const environmentSource = options.environment ?? process.env;
    const configuredPath = configuredKicadCliPath(options.executablePath, environmentSource);
    if (!path.isAbsolute(configuredPath)) {
      throw new KicadCliError("KiCad CLI executable path must be absolute.");
    }
    const executablePath = await resolveExistingFile(configuredPath, "KiCad CLI executable");
    const executableMetadataBeforeProbes = await stat(executablePath);
    const executableHashBeforeProbes = await sha256File(executablePath);
    if (options.expectedExecutableIdentity !== undefined &&
      (!/^[0-9a-f]{64}$/u.test(options.expectedExecutableIdentity.sha256) || !Number.isSafeInteger(options.expectedExecutableIdentity.sizeBytes) || options.expectedExecutableIdentity.sizeBytes < 1 ||
        executableMetadataBeforeProbes.size !== options.expectedExecutableIdentity.sizeBytes || executableHashBeforeProbes !== options.expectedExecutableIdentity.sha256)) {
      throw new KicadCliError("KiCad CLI executable does not match its server-owned content pin.");
    }
    const environment = buildEnvironment(environmentSource);
    const runner = options.runner ?? runBoundedProcess;
    const sourceBaseline = await collectNativeSources(projectRoot);

    const runProbe = async (args: readonly string[]): Promise<BoundedProcessResult> =>
      await runner({
        command: executablePath,
        args,
        cwd: workspaceRoot,
        env: environment,
        timeoutMs,
        maxOutputBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

    const versionResult = await runProbe(["version"]);
    assertSuccessful(versionResult, "KiCad version probe");
    const version = parseVersion(versionResult.stdout);
    const commitResult = await runProbe(["version", "--format", "commit"]);
    assertSuccessful(commitResult, "KiCad commit probe");
    const commit = commitResult.stdout.trim();
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
      throw new KicadCliError(`KiCad CLI returned an invalid commit identity '${commit || "empty"}'.`);
    }

    const capabilityHash = createHash("sha256");
    const confirmedCapabilities: string[] = [];
    const capabilityCaptures: Array<{
      readonly argv: readonly string[];
      readonly requiredTokens: readonly string[];
      readonly stdoutBytes: Uint8Array;
      readonly stderrBytes: Uint8Array;
    }> = [];
    for (const probe of CAPABILITY_PROBES) {
      const result = await runProbe(probe.args);
      assertSuccessful(result, `KiCad capability probe '${probe.args.slice(0, -1).join(" ")}'`);
      const help = `${result.stdout}\n${result.stderr}`;
      for (const token of probe.required) {
        if (!help.includes(token)) {
          throw new KicadCliError(
            `KiCad ${version} lacks required '${token}' support for '${probe.args.join(" ")}'.`,
          );
        }
      }
      const capabilityName = probe.args.slice(0, -1).join(" ");
      confirmedCapabilities.push(capabilityName);
      capabilityHash.update(`${probe.args.join("\0")}\0${help}\0`);
      capabilityCaptures.push({
        argv: [...probe.args],
        requiredTokens: [...probe.required],
        stdoutBytes: Buffer.from(result.stdout, "utf8"),
        stderrBytes: Buffer.from(result.stderr, "utf8"),
      });
    }

    const executableMetadata = await stat(executablePath);
    const executableHashAfterProbes = await sha256File(executablePath);
    if (executableMetadata.size !== executableMetadataBeforeProbes.size || executableHashAfterProbes !== executableHashBeforeProbes) {
      throw new KicadCliError("KiCad CLI executable changed while its identity was being probed.");
    }
    const sourcesAfterProbes = await collectNativeSources(projectRoot);
    const probeChanges = changedSourcePaths(sourceBaseline, sourcesAfterProbes, projectRoot);
    if (probeChanges.length > 0) {
      throw new KicadSourceMutationError(probeChanges);
    }
    const identity: KicadExecutableIdentity = {
      kind: "kicad-cli",
      path: executablePath,
      version,
      commit,
      sha256: executableHashAfterProbes,
      sizeBytes: executableMetadata.size,
      capabilityHelpSha256: capabilityHash.digest("hex"),
      confirmedCapabilities,
    };
    const portableCapabilityEvidence = buildKicadCapabilityByteEvidenceV1({
      version,
      commit,
      probes: capabilityCaptures,
    });
    const portableToolIdentity = buildKicadNativeToolIdentityV1({
      version,
      commit,
      executableContentIdentity: {
        algorithm: "sha256",
        digest: executableHashAfterProbes,
        size: executableMetadata.size,
      },
      helpCaptureBytes: portableCapabilityEvidence.helpCaptureBytes,
      capabilityManifestBytes: portableCapabilityEvidence.capabilityManifestBytes,
    });

    return new KicadCliAdapter({
      workspaceRoot,
      outputRoot,
      projectRoot,
      executablePath,
      environment,
      timeoutMs,
      maxOutputBytes,
      maxReportBytes,
      runner,
      identity,
      portableToolIdentity,
      portableCapabilityEvidence,
      sourceBaseline,
    });
  }

  get identity(): KicadExecutableIdentity {
    return detachedExecutableIdentity(this.#identity);
  }

  get portableRuntimeToolEvidence(): KicadPortableRuntimeToolEvidenceV1 {
    return detachedPortableRuntimeToolEvidence(
      this.#portableToolIdentity,
      this.#portableCapabilityEvidence,
    );
  }

  async #invoke(args: readonly string[], signal?: AbortSignal, environment: Readonly<Record<string, string>> = this.#environment): Promise<BoundedProcessResult> {
    const executableMetadata = await stat(this.#executablePath);
    if (
      executableMetadata.size !== this.#identity.sizeBytes ||
      (await sha256File(this.#executablePath)) !== this.#identity.sha256
    ) {
      throw new KicadCliError("KiCad CLI executable identity changed after adapter discovery.");
    }
    return await this.#runner({
      command: this.#executablePath,
      args,
      cwd: this.#projectRoot,
      env: environment,
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #withSourcePreservation<T>(operation: () => Promise<T>): Promise<{
    readonly value: T;
    readonly sourceHashes: Readonly<Record<string, string>>;
  }> {
    const before = await collectNativeSources(this.#projectRoot);
    const staleBefore = changedSourcePaths(this.#sourceBaseline, before, this.#projectRoot);
    if (staleBefore.length > 0) {
      throw new KicadSourceMutationError(staleBefore);
    }
    let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    try {
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }

    const after = await collectNativeSources(this.#projectRoot);
    const changed = changedSourcePaths(before, after, this.#projectRoot);
    if (changed.length > 0) {
      throw new KicadSourceMutationError(changed, {
        ...(outcome.ok ? {} : { cause: outcome.error }),
      });
    }
    if (!outcome.ok) throw outcome.error;
    return {
      value: outcome.value,
      sourceHashes: snapshotAsRecord(this.#sourceBaseline, this.#projectRoot),
    };
  }

  async #readCheckReport(
    kind: "erc" | "drc",
    reportPath: string,
    sourcePath: string,
  ): Promise<ParsedCheckReport> {
    const raw = await readBoundedText(reportPath, this.#maxReportBytes, `${kind.toUpperCase()} report`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new KicadCliError(`${kind.toUpperCase()} report is not valid JSON.`, { cause: error });
    }
    if (!isRecord(parsed)) {
      throw new KicadCliError(`${kind.toUpperCase()} report must be a JSON object.`);
    }
    const expectedSchema = `https://schemas.kicad.org/${kind}.v1.json`;
    if (parsed.$schema !== expectedSchema) {
      throw new KicadCliError(
        `${kind.toUpperCase()} report schema is '${String(parsed.$schema)}', expected '${expectedSchema}'.`,
      );
    }
    if (parsed.coordinate_units !== "mm") {
      throw new KicadCliError(`${kind.toUpperCase()} report did not use millimetres.`);
    }
    if (parsed.kicad_version !== this.#identity.version) {
      throw new KicadCliError(`${kind.toUpperCase()} report KiCad identity does not match the executable.`);
    }
    if (parsed.source !== path.basename(sourcePath)) {
      throw new KicadCliError(`${kind.toUpperCase()} report source does not match its requested input.`);
    }
    const immutableReport = deepFreezePublicResult(
      structuredClone(parsed),
    ) as Readonly<Record<string, unknown>>;

    if (kind === "erc") {
      const sheets = asRecordArray(parsed.sheets, "ERC report sheets");
      let violationCount = 0;
      for (const [index, sheet] of sheets.entries()) {
        violationCount += asRecordArray(
          sheet.violations,
          `ERC report sheet ${index} violations`,
        ).length;
      }
      return Object.freeze({
        report: immutableReport,
        violationCount,
        schematicParityCount: 0,
      });
    }

    const violations = asRecordArray(parsed.violations, "DRC report violations");
    const unconnected = asRecordArray(parsed.unconnected_items, "DRC unconnected items");
    const schematicParity = asRecordArray(parsed.schematic_parity, "DRC schematic parity");
    return Object.freeze({
      report: immutableReport,
      violationCount: violations.length + unconnected.length + schematicParity.length,
      schematicParityCount: schematicParity.length,
    });
  }

  #assertCheckExit(kind: "ERC" | "DRC", result: BoundedProcessResult, findings: number): void {
    const expected = findings === 0 ? 0 : KICAD_DESIGN_VIOLATIONS_EXIT_CODE;
    if (result.exitCode !== expected) {
      throw new KicadCliInvocationError(
        `${kind} exit/report mismatch: ${findings} findings require exit code ${expected}, received ${result.exitCode}.`,
        result,
      );
    }
  }

  #assertCheckProducedReport(kind: "ERC" | "DRC", result: BoundedProcessResult): void {
    if (result.exitCode !== 0 && result.exitCode !== KICAD_DESIGN_VIOLATIONS_EXIT_CODE) {
      throw new KicadCliInvocationError(
        `${kind} failed with KiCad CLI exit code ${result.exitCode} before producing a usable report.`,
        result,
      );
    }
  }

  async runChecks(options: KicadCheckOptions): Promise<KicadCheckResult> {
    // This legacy candidate check is intentionally source-preserving. It is not
    // the portable-validation V2 capture path: that contract requires DRC
    // --refill-zones/--save-board against a per-command isolated writable copy
    // and is constructed/resolved by portable-kicad-runtime.ts.
    const inputs = await validateDesignInputs(
      this.#projectRoot,
      options.schematicPath,
      options.pcbPath,
    );
    const outputRoot = await prepareEmptyOutputDirectory(
      this.#outputRoot,
      this.#outputRoot,
      options.outputDirectory,
      [this.#projectRoot],
    );
    const ercPath = path.join(outputRoot, "erc.json");
    const drcPath = path.join(outputRoot, "drc.json");

    const guarded = await this.#withSourcePreservation(async () => {
      const ercResult = await this.#invoke(
        [
          "sch",
          "erc",
          "--output",
          ercPath,
          "--format",
          "json",
          "--units",
          "mm",
          "--severity-all",
          "--exit-code-violations",
          inputs.schematicPath,
        ],
        options.signal,
      );
      this.#assertCheckProducedReport("ERC", ercResult);
      const ercReport = await this.#readCheckReport("erc", ercPath, inputs.schematicPath);
      this.#assertCheckExit("ERC", ercResult, ercReport.violationCount);

      const drcResult = await this.#invoke(
        [
          "pcb",
          "drc",
          "--output",
          drcPath,
          "--format",
          "json",
          "--units",
          "mm",
          "--severity-all",
          "--exit-code-violations",
          "--schematic-parity",
          inputs.pcbPath,
        ],
        options.signal,
      );
      this.#assertCheckProducedReport("DRC", drcResult);
      const drcReport = await this.#readCheckReport("drc", drcPath, inputs.pcbPath);
      this.#assertCheckExit("DRC", drcResult, drcReport.violationCount);

      const erc: KicadNativeCheck = {
        kind: "erc",
        status: ercReport.violationCount === 0 ? "clean" : "violations",
        reportPath: ercPath,
        violationCount: ercReport.violationCount,
        schematicParityCount: 0,
        report: ercReport.report,
        invocation: invocationEvidence(this.#identity, ercResult),
      };
      const drc: KicadNativeCheck = {
        kind: "drc",
        status: drcReport.violationCount === 0 ? "clean" : "violations",
        reportPath: drcPath,
        violationCount: drcReport.violationCount,
        schematicParityCount: drcReport.schematicParityCount,
        report: drcReport.report,
        invocation: invocationEvidence(this.#identity, drcResult),
      };
      return { erc, drc };
    });

    return deepFreezePublicResult({
      classification: "candidate-validation",
      releaseAuthorized: false,
      executable: this.identity,
      sourceHashes: guarded.sourceHashes,
      erc: guarded.value.erc,
      drc: guarded.value.drc,
      clean: guarded.value.erc.status === "clean" && guarded.value.drc.status === "clean",
    });
  }

  /** Export only the native schematic netlist for a post-save topology parity gate. */
  async exportSchematicNetlist(
    options: KicadSchematicNetlistOptions,
  ): Promise<KicadSchematicNetlistResult> {
    const inputs = await validateDesignInputs(
      this.#projectRoot,
      options.schematicPath,
      options.pcbPath,
    );
    const outputRoot = await prepareEmptyOutputDirectory(
      this.#outputRoot,
      this.#outputRoot,
      options.outputDirectory,
      [this.#projectRoot],
    );
    const netlistPath = path.join(outputRoot, "schematic-netlist.kicad_net");
    const guarded = await this.#withSourcePreservation(async () => {
      const result = await this.#invoke([
        "sch", "export", "netlist", "--output", netlistPath, "--format", "kicadsexpr", inputs.schematicPath,
      ], options.signal);
      assertSuccessful(result, "KiCad native schematic netlist export");
      const artifacts = await collectArtifacts(outputRoot);
      if (artifacts.length !== 1 || artifacts[0]?.relativePath !== "schematic-netlist.kicad_net") {
        throw new KicadCliError("KiCad native schematic parity export must emit exactly one netlist artifact.");
      }
      const source = await readBoundedText(netlistPath, this.#maxReportBytes, "KiCad schematic netlist");
      return { invocation: invocationEvidence(this.#identity, result), schematicNetlist: artifacts[0]!, source };
    });
    return deepFreezePublicResult({
      classification: "candidate-validation",
      releaseAuthorized: false,
      executable: this.identity,
      outputDirectory: outputRoot,
      sourceHashes: guarded.sourceHashes,
      invocation: guarded.value.invocation,
      schematicNetlist: guarded.value.schematicNetlist,
      source: guarded.value.source,
    });
  }

  /** Export one native schematic sheet for an in-run, host-only ink-clearance check. */
  async exportSchematicSvg(options: KicadSchematicSvgOptions): Promise<KicadSchematicSvgResult> {
    return await this.#captureSchematicSvg(options);
  }

  /** Display-only fixed PCB views; native success is not engineering acceptance. */
  async exportPcbSvg(options: KicadPcbSvgOptions): Promise<KicadPcbSvgResult> {
    if (options.view !== "top" && options.view !== "assembly") throw new KicadCliError("Unsupported PCB SVG view.");
    const inputs = await validateDesignInputs(this.#projectRoot, options.schematicPath, options.pcbPath);
    const outputRoot = await prepareEmptyOutputDirectory(this.#outputRoot, this.#outputRoot, options.outputDirectory, [this.#projectRoot]);
    const filename = `board-${options.view}.svg`;
    const layers = options.view === "top" ? ["F.Cu", "F.Silkscreen", "Edge.Cuts"] : ["F.Fab", "F.Silkscreen", "Edge.Cuts"];
    const guarded = await this.#withSourcePreservation(async () => {
      const stateRoot = await prepareEmptyOutputDirectory(this.#outputRoot, this.#outputRoot,
        path.join(path.dirname(outputRoot), `.pcb-svg-state-${randomUUID()}`), [this.#projectRoot, outputRoot]);
      const home = path.join(stateRoot, "home");
      const roaming = path.join(home, "AppData", "Roaming");
      const local = path.join(home, "AppData", "Local");
      const temporary = path.join(stateRoot, "temp");
      const config = path.join(stateRoot, "config");
      const cache = path.join(stateRoot, "cache");
      await Promise.all([roaming, local, temporary, config, cache].map(directory => mkdir(directory, { recursive: true })));
      const environment = Object.freeze({ ...this.#environment, HOME: home, USERPROFILE: home,
        APPDATA: roaming, LOCALAPPDATA: local, TEMP: temporary, TMP: temporary,
        KICAD_CONFIG_HOME: config, KICAD_CACHE_HOME: cache, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache });
      const result = await this.#invoke(["pcb", "export", "svg", "--layers", layers.join(","),
        ...(options.view === "assembly" ? ["--sketch-pads-on-fab-layers"] : []),
        // Native autoscale centers the complete board/footprint bounding box
        // on the existing page. Board-only mode clips off-board value text.
        "--page-size-mode", "1", "--scale", "0", "--exclude-drawing-sheet", "--drill-shape-opt", "2", "--mode-single",
        "--output", path.join(outputRoot, filename), inputs.pcbPath], options.signal, environment);
      assertSuccessful(result, "KiCad native PCB SVG export");
      const artifacts = await collectArtifacts(outputRoot);
      const pcbSvg = artifacts[0];
      if (artifacts.length !== 1 || pcbSvg?.relativePath !== filename || pcbSvg.sizeBytes > this.#maxReportBytes) {
        throw new KicadCliError("PCB SVG export must emit exactly one bounded matching artifact.");
      }
      const bytes = await readFile(pcbSvg.path);
      const identity = contentIdentity(bytes);
      if (identity.digest !== pcbSvg.sha256 || identity.size !== pcbSvg.sizeBytes) throw new KicadCliError("PCB SVG changed while captured.");
      let source: string;
      try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new KicadCliError("PCB SVG is not valid UTF-8."); }
      if (!/<svg(?:\s|\/?>)/u.test(source)) throw new KicadCliError("PCB SVG export did not contain an SVG document.");
      return { invocation: invocationEvidence(this.#identity, result), pcbSvg, source };
    });
    return deepFreezePublicResult({ classification: "candidate-preview", releaseAuthorized: false, executable: this.identity,
      sourceHashes: guarded.sourceHashes, view: options.view, layers, ...guarded.value });
  }

  async #captureSchematicSvg(options: KicadSchematicSvgOptions, environment?: Readonly<Record<string, string>>, protectedRoots: readonly string[] = []): Promise<KicadSchematicSvgResult> {
    const inputs = await validateDesignInputs(this.#projectRoot, options.schematicPath, options.pcbPath);
    const outputRoot = await prepareEmptyOutputDirectory(this.#outputRoot, this.#outputRoot, options.outputDirectory, [this.#projectRoot, ...protectedRoots]);
    const sourcePaths = { schematic: inputs.schematicPath, pcb: inputs.pcbPath, projectSettings: inputs.projectFilePath };
    const guarded = await this.#withSourcePreservation(async () => {
      const sourceIdentities = {} as Record<keyof KicadSchematicSourceIdentities, ContentIdentity>;
      for (const key of ["schematic", "pcb", "projectSettings"] as const) {
        const metadata = await lstat(sourcePaths[key]);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > this.#maxReportBytes) throw new KicadCliError("Schematic SVG source is not a bounded ordinary file.");
        sourceIdentities[key] = contentIdentity(await readFile(sourcePaths[key]));
      }
      const result = await this.#invoke([
        "sch", "export", "svg", "--output", outputRoot, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", inputs.schematicPath,
      ], options.signal, environment);
      assertSuccessful(result, "KiCad native schematic SVG export");
      const artifacts = await collectArtifacts(outputRoot);
      const schematicSvg = artifacts[0];
      if (artifacts.length !== 1 || schematicSvg?.relativePath !== `${inputs.designName}.svg`) throw new KicadCliError("KiCad schematic SVG export must emit exactly one matching sheet artifact.");
      const bytes = await readFile(schematicSvg.path);
      const captured = contentIdentity(bytes);
      if (captured.digest !== schematicSvg.sha256 || captured.size !== schematicSvg.sizeBytes || captured.size > this.#maxReportBytes) throw new KicadCliError("KiCad schematic SVG changed while its exact bytes were captured.");
      let source: string;
      try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new KicadCliError("KiCad schematic SVG is not valid UTF-8."); }
      return { sourceIdentities, invocation: invocationEvidence(this.#identity, result), schematicSvg, source };
    });
    for (const key of ["schematic", "pcb", "projectSettings"] as const) {
      const relative = path.relative(this.#projectRoot, sourcePaths[key]).split(path.sep).join("/");
      if (guarded.sourceHashes[relative] !== guarded.value.sourceIdentities[key].digest) throw new KicadSourceMutationError([relative]);
    }
    return deepFreezePublicResult({
      classification: "candidate-validation", releaseAuthorized: false, executable: this.identity,
      outputDirectory: outputRoot, sourceHashes: guarded.sourceHashes, ...guarded.value,
    });
  }

  async #ownedSchematicDirectory(rawPath: string, label: string): Promise<string> {
    if (typeof rawPath !== "string" || !path.isAbsolute(rawPath) || rawPath.includes("\0")) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", `${label} must be an explicit absolute private path.`);
    const requested = path.resolve(rawPath); const root = [this.#outputRoot, this.#workspaceRoot].find((candidate) => isPathWithin(candidate, requested, false));
    if (root === undefined) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", `${label} is outside the adapter's owned roots.`);
    assertDisjointDirectories(this.#projectRoot, requested, "Native design", label);
    let cursor = root;
    for (const name of path.relative(root, requested).split(path.sep)) {
      cursor = path.join(cursor, name); const metadata = await lstat(cursor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePhysicalPath(await realpath(cursor), cursor)) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", `${label} may not resolve through directory links.`);
    }
    return requested;
  }

  /** Read-only pin of a caller-created isolated configuration, including empty directories. */
  async captureSchematicConfiguration(configHome: string): Promise<KicadSchematicConfigurationSnapshot> {
    return (await captureConfigurationTree(await this.#ownedSchematicDirectory(configHome, "Schematic configuration"))).snapshot;
  }

  async #captureApprovedSchematicBinary(filePath: string, expected: ContentIdentity): Promise<Readonly<{ identity: ContentIdentity; physical: ConfigurationPhysicalIdentity }>> {
    const before = await lstat(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expected.size) || !samePhysicalPath(await realpath(filePath), filePath)) throw new KicadCliError("Schematic stroke renderer must be an approved ordinary nonlinked binary.");
    const digest = await sha256File(filePath); const after = await lstat(filePath, { bigint: true });
    if (digest !== expected.digest || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new KicadCliError("Schematic stroke renderer content changed or differs from the approved native profile.");
    return { identity: { algorithm: "sha256", digest, size: expected.size }, physical: physicalIdentity(filePath, "file", after) };
  }

  /** Native body-stroke authority under explicit owned config/cache roots; never changes user settings. */
  async exportSchematicSvgWithStrokeStyle(options: KicadSchematicSvgStrokeStyleOptions): Promise<KicadSchematicSvgStrokeStyleResult> {
    options.signal?.throwIfAborted();
    const profile = FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE;
    if (this.#identity.version !== profile.version || this.#identity.sha256 !== profile.executable.digest || this.#identity.sizeBytes !== profile.executable.size) throw new KicadCliError("Schematic stroke capture requires the exact approved KiCad 10.0.3 executable.");
    if (options.configuration === undefined || options.configuration === null) throw new KicadSchematicConfigurationError("INVALID_CONFIGURATION", "Explicit owned schematic configuration and cache authority are required.");
    const configHome = await this.#ownedSchematicDirectory(options.configuration.configHome, "Schematic configuration");
    const cacheHome = await this.#ownedSchematicDirectory(options.configuration.cacheHome, "Schematic cache");
    assertDisjointDirectories(configHome, cacheHome, "Schematic configuration", "Schematic cache");
    await validateSchematicCacheTree(cacheHome);
    const expectedTree = validateCanonicalIdentity(options.configuration.expectedTreeIdentity, "Schematic configuration tree identity");
    const before = await captureConfigurationTree(configHome);
    if (expectedTree.schemaVersion !== KICAD_SCHEMATIC_CONFIGURATION_TREE_SCHEMA_VERSION || canonicalJson(before.snapshot.identity) !== canonicalJson(expectedTree)) throw new KicadSchematicConfigurationError("CONFIGURATION_DRIFT", "Owned schematic configuration differs from its admitted tree identity.");
    const executableBefore = await this.#captureApprovedSchematicBinary(this.#executablePath, profile.executable);
    const enginePath = path.join(path.dirname(this.#executablePath), "_eeschema.dll");
    const engineBefore = await this.#captureApprovedSchematicBinary(enginePath, profile.schematicEngine);
    const inputs = await validateDesignInputs(this.#projectRoot, options.schematicPath, options.pcbPath);
    const projectSettings = await captureOrdinaryConfigurationFile(inputs.projectFilePath, this.#maxReportBytes);
    let projectSettingsSource: string; try { projectSettingsSource = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(projectSettings.bytes); }
    catch { throw new KicadCliError("Schematic stroke project settings are not exact UTF-8."); }
    const preferencePath = path.join(path.dirname(inputs.projectFilePath), `${inputs.designName}.kicad_prl`);
    const preferences = async (): Promise<ContentIdentity | null> => {
      try { return (await captureOrdinaryConfigurationFile(preferencePath, this.#maxReportBytes)).identity; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    };
    const preferencesBefore = await preferences();
    const environment: Record<string, string> = {};
    for (const key of ["SystemRoot", "WINDIR", "KICAD10_SYMBOL_DIR", "KICAD10_FOOTPRINT_DIR", "KICAD10_3DMODEL_DIR", "KICAD10_TEMPLATE_DIR", "KICAD10_USER_TEMPLATE_DIR"] as const) if (this.#environment[key] !== undefined) environment[key] = this.#environment[key]!;
    Object.assign(environment, { KICAD_CONFIG_HOME: configHome, KICAD_CACHE_HOME: cacheHome, XDG_CACHE_HOME: cacheHome,
      HOME: cacheHome, USERPROFILE: cacheHome, APPDATA: cacheHome, LOCALAPPDATA: cacheHome, TEMP: cacheHome, TMP: cacheHome,
      NO_COLOR: "1", LANG: "C", LANGUAGE: "C", LC_ALL: "C" });
    options.signal?.throwIfAborted();
    let outcome: { ok: true; render: KicadSchematicSvgResult } | { ok: false; error: unknown };
    try { outcome = { ok: true, render: await this.#captureSchematicSvg(options, Object.freeze(environment), [configHome, cacheHome]) }; }
    catch (error) { outcome = { ok: false, error }; }
    let after: CapturedSchematicConfiguration; let executableAfter: typeof executableBefore; let engineAfter: typeof engineBefore;
    try {
      await this.#ownedSchematicDirectory(configHome, "Schematic configuration"); await this.#ownedSchematicDirectory(cacheHome, "Schematic cache");
      await validateSchematicCacheTree(cacheHome);
      after = await captureConfigurationTree(configHome);
      if (canonicalJson(before.snapshot.identity) !== canonicalJson(after.snapshot.identity) || canonicalJson(before.physical) !== canonicalJson(after.physical)) throw new KicadSchematicConfigurationError("CONFIGURATION_DRIFT", "Owned schematic configuration files or directories changed during SVG export.");
      executableAfter = await this.#captureApprovedSchematicBinary(this.#executablePath, profile.executable);
      engineAfter = await this.#captureApprovedSchematicBinary(enginePath, profile.schematicEngine);
      if (canonicalJson(executableBefore.physical) !== canonicalJson(executableAfter.physical) || canonicalJson(engineBefore.physical) !== canonicalJson(engineAfter.physical)) throw new KicadCliError("Schematic stroke renderer physical identity changed during SVG export.");
    } catch (error) {
      throw new KicadSchematicConfigurationError("CONFIGURATION_DRIFT", "Schematic SVG configuration or renderer preservation failed.", { cause: outcome.ok ? error : new AggregateError([outcome.error, error], "Native export and preservation both failed.") });
    }
    if (!outcome.ok) throw outcome.error;
    options.signal?.throwIfAborted();
    const capture: FreshSchematicStrokeStyleCapture = { render: outcome.render, projectSettingsSource,
      schematicEngine: { path: enginePath, before: engineBefore.identity, after: engineAfter.identity },
      configuration: { isolation: "caller-owned-isolated", configHome, treeBefore: before.snapshot.identity, treeAfter: after.snapshot.identity,
        applicationConfig: { relativePath: "10.0/eeschema.json", source: before.snapshot.applicationConfig.source, before: before.snapshot.applicationConfig.identity, after: after.snapshot.applicationConfig.identity } } };
    const localPreferences = { relativePath: `${inputs.designName}.kicad_prl`, before: preferencesBefore, after: await preferences() };
    const finalSvg = await captureOrdinaryConfigurationFile(outcome.render.schematicSvg.path, this.#maxReportBytes);
    if (canonicalJson(finalSvg.identity) !== canonicalJson(contentIdentity(outcome.render.source))) throw new KicadCliError("Native schematic SVG changed before stroke-style authority publication.");
    const changes = changedSourcePaths(this.#sourceBaseline, await collectNativeSources(this.#projectRoot), this.#projectRoot);
    if (changes.length > 0) throw new KicadSourceMutationError(changes);
    const strokeStyleEvidence = createFreshSchematicStrokeStyleEvidence(capture, outcome.render.sourceIdentities);
    options.signal?.throwIfAborted();
    return deepFreezePublicResult({ ...outcome.render, strokeStyleEvidence, strokeStyleCapture: capture, localPreferences });
  }

  async inspectNativeDesign(
    options: KicadNativeInspectionOptions,
  ): Promise<KicadNativeInspectionResult> {
    const inputs = await validateDesignInputs(
      this.#projectRoot,
      options.schematicPath,
      options.pcbPath,
    );
    const outputRoot = await prepareEmptyOutputDirectory(
      this.#outputRoot,
      this.#outputRoot,
      options.outputDirectory,
      [this.#projectRoot],
    );
    const netlistPath = path.join(outputRoot, "schematic-netlist.kicad_net");
    const statisticsPath = path.join(outputRoot, "board-statistics.json");
    const boardNetlistPath = path.join(outputRoot, "board-netlist.d356");
    const commands: readonly (readonly string[])[] = [
      [
        "sch",
        "export",
        "netlist",
        "--output",
        netlistPath,
        "--format",
        "kicadsexpr",
        inputs.schematicPath,
      ],
      [
        "pcb",
        "export",
        "stats",
        "--output",
        statisticsPath,
        "--format",
        "json",
        "--units",
        "mm",
        "--subtract-holes-from-board",
        "--subtract-holes-from-copper",
        inputs.pcbPath,
      ],
      [
        "pcb",
        "export",
        "ipcd356",
        "--output",
        boardNetlistPath,
        inputs.pcbPath,
      ],
    ];

    const guarded = await this.#withSourcePreservation(async () => {
      const invocations: KicadCliInvocationEvidence[] = [];
      for (const command of commands) {
        const result = await this.#invoke(command, options.signal);
        assertSuccessful(result, `KiCad native inspection '${command.slice(0, 3).join(" ")}'`);
        invocations.push(invocationEvidence(this.#identity, result));
      }
      const artifacts = await collectArtifacts(outputRoot);
      const byRelativePath = new Map(
        artifacts.map((artifact) => [artifact.relativePath, artifact] as const),
      );
      const schematicNetlist = byRelativePath.get("schematic-netlist.kicad_net");
      const boardStatistics = byRelativePath.get("board-statistics.json");
      const boardNetlist = byRelativePath.get("board-netlist.d356");
      if (schematicNetlist === undefined) {
        throw new KicadCliError("KiCad native schematic netlist output is missing.");
      }
      if (boardStatistics === undefined) {
        throw new KicadCliError("KiCad native board statistics output is missing.");
      }
      if (boardNetlist === undefined) {
        throw new KicadCliError("KiCad native IPC-D-356 board netlist output is missing.");
      }

      const statisticsText = await readBoundedText(
        boardStatistics.path,
        this.#maxReportBytes,
        "KiCad board statistics",
      );
      let statistics: unknown;
      try {
        statistics = JSON.parse(statisticsText) as unknown;
      } catch (error) {
        throw new KicadCliError("KiCad board statistics are not valid JSON.", { cause: error });
      }
      if (!isRecord(statistics) || !isRecord(statistics.metadata) || !isRecord(statistics.board)) {
        throw new KicadCliError("KiCad board statistics have an unsupported structure.");
      }
      if (statistics.metadata.generator !== `KiCad ${this.#identity.version}`) {
        throw new KicadCliError(
          "KiCad board statistics generator does not match the executable identity.",
        );
      }
      if (
        statistics.metadata.project !== inputs.designName ||
        statistics.metadata.board_name !== inputs.designName
      ) {
        throw new KicadCliError("KiCad board statistics do not identify the requested project.");
      }
      if (statistics.board.has_outline !== true) {
        throw new KicadCliError("KiCad board statistics report no closed board outline.");
      }
      return { invocations, schematicNetlist, boardStatistics, boardNetlist };
    });

    return deepFreezePublicResult({
      classification: "candidate-validation",
      releaseAuthorized: false,
      executable: this.identity,
      outputDirectory: outputRoot,
      sourceHashes: guarded.sourceHashes,
      invocations: guarded.value.invocations,
      schematicNetlist: guarded.value.schematicNetlist,
      boardStatistics: guarded.value.boardStatistics,
      boardNetlist: guarded.value.boardNetlist,
    });
  }

  async exportCandidateArtifacts(
    options: KicadCandidateExportOptions,
  ): Promise<KicadCandidateExportResult> {
    const inputs = await validateDesignInputs(
      this.#projectRoot,
      options.schematicPath,
      options.pcbPath,
    );
    const outputRoot = await prepareEmptyOutputDirectory(
      this.#outputRoot,
      this.#outputRoot,
      options.outputDirectory,
      [this.#projectRoot],
    );
    const boardSource = await readBoundedText(
      inputs.pcbPath,
      this.#maxReportBytes,
      "KiCad PCB source",
    );
    const gerberLayers = extractGerberLayers(boardSource);
    const schematicOutput = path.join(outputRoot, "schematic");
    const gerberOutput = path.join(outputRoot, "gerbers");
    const drillOutput = path.join(outputRoot, "drill");
    const renderOutput = path.join(outputRoot, "renders");
    await Promise.all(
      [schematicOutput, gerberOutput, drillOutput, renderOutput].map(
        async (directory) => await mkdir(directory),
      ),
    );

    // KiCad 10.0.3 advertises value-taking boolean switches for BOM sort direction and
    // stackup colors, but passing either `true` value terminates with std::bad_any_cast.
    // Their documented defaults are already true, so the stable command omits those two
    // switches while spelling out every non-broken output-affecting option.
    const commands: readonly (readonly string[])[] = [
      [
        "sch",
        "export",
        "bom",
        "--output",
        path.join(outputRoot, "bom.csv"),
        "--fields",
        "Reference,Value,Footprint,Datasheet,Manufacturer,MPN,QUANTITY,DNP",
        "--labels",
        "Reference,Value,Footprint,Datasheet,Manufacturer,MPN,Quantity,DNP",
        "--group-by",
        "Value,Footprint,Datasheet,Manufacturer,MPN,DNP",
        "--sort-field",
        "Reference",
        "--field-delimiter",
        ",",
        "--string-delimiter",
        '"',
        "--ref-delimiter",
        ",",
        "--ref-range-delimiter",
        "-",
        inputs.schematicPath,
      ],
      [
        "sch",
        "export",
        "netlist",
        "--output",
        path.join(outputRoot, "netlist.kicad_net"),
        "--format",
        "kicadsexpr",
        inputs.schematicPath,
      ],
      [
        "sch",
        "export",
        "svg",
        "--output",
        schematicOutput,
        "--black-and-white",
        "--exclude-drawing-sheet",
        "--no-background-color",
        inputs.schematicPath,
      ],
      [
        "pcb",
        "export",
        "gerbers",
        "--output",
        gerberOutput,
        "--layers",
        gerberLayers.join(","),
        "--precision",
        "6",
        "--no-protel-ext",
        inputs.pcbPath,
      ],
      [
        "pcb",
        "export",
        "drill",
        "--output",
        drillOutput,
        "--format",
        "excellon",
        "--drill-origin",
        "absolute",
        "--excellon-zeros-format",
        "decimal",
        "--excellon-oval-format",
        "alternate",
        "--excellon-units",
        "mm",
        "--excellon-separate-th",
        "--generate-map",
        "--map-format",
        "svg",
        "--generate-report",
        "--report-path",
        path.join(drillOutput, "drill-report.rpt"),
        inputs.pcbPath,
      ],
      [
        "pcb",
        "export",
        "pos",
        "--output",
        path.join(outputRoot, "positions.csv"),
        "--side",
        "both",
        "--format",
        "csv",
        "--units",
        "mm",
        "--exclude-dnp",
        inputs.pcbPath,
      ],
      ...(["top", "bottom"] as const).map(
        (side): readonly string[] => [
          "pcb",
          "render",
          "--output",
          path.join(renderOutput, `board-${side}.png`),
          "--width",
          "1600",
          "--height",
          "900",
          "--side",
          side,
          "--background",
          "transparent",
          "--quality",
          "high",
          "--preset",
          "follow_plot_settings",
          "--zoom",
          "1",
          inputs.pcbPath,
        ],
      ),
    ];

    const guarded = await this.#withSourcePreservation(async () => {
      const invocations: KicadCliInvocationEvidence[] = [];
      for (const command of commands) {
        const result = await this.#invoke(command, options.signal);
        assertSuccessful(result, `KiCad candidate export '${command.slice(0, 3).join(" ")}'`);
        invocations.push(invocationEvidence(this.#identity, result));
      }
      const artifacts = await collectArtifacts(outputRoot);
      assertRequiredArtifacts(artifacts);
      return { invocations, artifacts };
    });

    return deepFreezePublicResult({
      classification: "candidate",
      releaseAuthorized: false,
      executable: this.identity,
      outputDirectory: outputRoot,
      sourceHashes: guarded.sourceHashes,
      gerberLayers,
      invocations: guarded.value.invocations,
      artifacts: guarded.value.artifacts,
    });
  }

  /**
   * Renders only the three display artifacts used by a local review surface.
   * This never asks KiCad for BOM, netlist, Gerber, drill, position, or any
   * manufacturing-oriented output, and retains the same source preservation
   * guard as validation/export operations.
   */
  async exportPreviewArtifacts(
    options: KicadPreviewExportOptions,
  ): Promise<KicadPreviewExportResult> {
    const inputs = await validateDesignInputs(
      this.#projectRoot,
      options.schematicPath,
      options.pcbPath,
    );
    const outputRoot = await prepareEmptyOutputDirectory(
      this.#outputRoot,
      this.#outputRoot,
      options.outputDirectory,
      [this.#projectRoot],
    );
    const schematicOutput = path.join(outputRoot, "schematic");
    const renderOutput = path.join(outputRoot, "renders");
    await Promise.all([mkdir(schematicOutput), mkdir(renderOutput)]);
    const commands: readonly (readonly string[])[] = [
      [
        "sch", "export", "svg",
        "--output", schematicOutput,
        "--black-and-white",
        "--exclude-drawing-sheet",
        "--no-background-color",
        inputs.schematicPath,
      ],
      ...(["top", "bottom"] as const).map((side): readonly string[] => [
        "pcb", "render",
        "--output", path.join(renderOutput, `board-${side}.png`),
        "--width", "1600",
        "--height", "900",
        "--side", side,
        "--background", "transparent",
        "--quality", "high",
        "--preset", "follow_plot_settings",
        "--zoom", "1",
        inputs.pcbPath,
      ]),
    ];
    const guarded = await this.#withSourcePreservation(async () => {
      const invocations: KicadCliInvocationEvidence[] = [];
      for (const command of commands) {
        const result = await this.#invoke(command, options.signal);
        assertSuccessful(result, `KiCad preview '${command.slice(0, 3).join(" ")}'`);
        invocations.push(invocationEvidence(this.#identity, result));
      }
      const artifacts = await collectArtifacts(outputRoot);
      assertPreviewArtifacts(artifacts);
      return { invocations, artifacts };
    });
    return deepFreezePublicResult({
      classification: "candidate-preview",
      releaseAuthorized: false,
      executable: this.identity,
      outputDirectory: outputRoot,
      sourceHashes: guarded.sourceHashes,
      invocations: guarded.value.invocations,
      artifacts: guarded.value.artifacts,
    });
  }
}

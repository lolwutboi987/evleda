import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readKicadNativeProfile } from "../flux/production-composition.js";
import { createKicadTransmissionLineCalculator } from "../integrations/kicad-transmission-line.js";
import { BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION } from "../integrations/bounded-process.js";
import { loadKicadToolboxFreshProfile } from "./toolbox-fresh-profile.js";
import { createToolboxWorkspaceStore } from "./toolbox-workspace-store.js";
import { createKicadToolboxWorkspace } from "./toolbox-workspace.js";
import { formatNativeToolboxError } from "./toolbox-native-main.js";

export const toolboxWorkspaceUsage = `Usage: pnpm mcp:toolbox:workspace --profile <file> --profile-sha256 <sha256> --profile-bytes <bytes> --workspace-root <existing-directory> [--edit]

Connects immediately with guidance, design schema, library inspection and in-chat draft compilation.
An explicit stock catalog profile also enables bounded library search.
KiCad opens only after evleda_create_project or evleda_resume_project.
The host selects the profile/workspace and edit policy once; model calls use opaque project IDs.
Unresolved drafts return questions in-band without creating native project folders.
`;

export function parseToolboxWorkspaceArgs(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    profile: { type: "string" }, "profile-sha256": { type: "string" }, "profile-bytes": { type: "string" },
    "workspace-root": { type: "string" }, edit: { type: "boolean", default: false }, help: { type: "boolean" },
  } });
  if (values.help) return undefined;
  for (const key of ["profile", "profile-sha256", "profile-bytes", "workspace-root"] as const) if (!values[key]?.trim()) throw new Error(`Missing --${key}.`);
  const digest = values["profile-sha256"]!, size = Number(values["profile-bytes"]);
  if (!/^[0-9a-f]{64}$/u.test(digest) || !/^[1-9][0-9]*$/u.test(values["profile-bytes"]!) || !Number.isSafeInteger(size)) throw new Error("Workspace profile requires exact SHA-256 and byte count.");
  return Object.freeze({ profile: { path: path.resolve(values.profile!), contentIdentity: { algorithm: "sha256" as const, digest, size } },
    workspaceRoot: path.resolve(values["workspace-root"]!), access: values.edit ? "edit" as const : "read-only" as const });
}

/** Only host profile/library preparation here; no runtime bridge or editor launch. */
export async function loadKicadToolboxWorkspace(options: NonNullable<ReturnType<typeof parseToolboxWorkspaceArgs>>) {
  const [native, design] = await Promise.all([readKicadNativeProfile(options.profile), loadKicadToolboxFreshProfile(options.profile)]);
  const stock = path.resolve(native.kicadToolchain.binRoot, "..", "share", "kicad");
  for (const [actual, expected] of [[design.libraryEnvironment.KICAD10_SYMBOL_DIR, path.join(stock, "symbols")],
    [design.libraryEnvironment.KICAD10_FOOTPRINT_DIR, path.join(stock, "footprints")]]) {
    if ((await realpath(actual!)).toLowerCase() !== (await realpath(expected!)).toLowerCase()) throw new Error("Workspace libraries must match the pinned KiCad installation.");
  }
  const runtime = native.kicadMcpRuntime;
  const store = await createToolboxWorkspaceStore({ workspaceRoot: options.workspaceRoot,
    protectedRoots: [native.path, native.kicadToolchain.binRoot, runtime.runtimeBundle.root, runtime.lock.path,
      runtime.runtimeBundle.manifest.path, runtime.processTreeSupervision.terminator.path,
      runtime.runtimeParentRoot, runtime.ipcSocketParentRoot, ...design.protectedRoots,
      ...(native.kicadTransmissionLine === undefined ? [] : [path.dirname(native.kicadTransmissionLine.path)]),
      ...(native.kicadReferenceCoverage === undefined ? [] : [path.dirname(native.kicadReferenceCoverage.path)])] });
  const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot, windowsDirectory = process.env.WINDIR ?? process.env.windir;
  if (!systemRoot || !windowsDirectory || path.resolve(systemRoot).toLowerCase() !== path.resolve(windowsDirectory).toLowerCase()) throw new Error("Expected matching Windows system directories.");
  const environment = { SYSTEMROOT: systemRoot, WINDIR: windowsDirectory };
  const transmissionLine = native.kicadTransmissionLine === undefined ? undefined : await createKicadTransmissionLineCalculator({
    executablePath: native.kicadTransmissionLine.path,
    expectedExecutableIdentity: { sha256: native.kicadTransmissionLine.identity.digest, sizeBytes: native.kicadTransmissionLine.identity.size },
    cwd: path.dirname(native.kicadTransmissionLine.path), environment,
    windowsProcessTreeTermination: { schemaVersion: BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
      executablePath: runtime.processTreeSupervision.terminator.path, executableIdentity: runtime.processTreeSupervision.terminator.identity,
      cwd: runtime.runtimeBundle.root, env: environment } });
  return createKicadToolboxWorkspace({ profile: options.profile, store, dependencies: design.dependencies,
    deepRuleSelectionOptions: design.deepRuleSelectionOptions, access: options.access,
    ...(transmissionLine === undefined ? {} : { transmissionLine }),
    ...(design.searchLibrary === undefined ? {} : { searchLibrary: design.searchLibrary }),
    ...(design.describeApprovedPackage === undefined ? {} : { describeApprovedPackage: design.describeApprovedPackage }),
    inspectLibrary: (kind, libraryId) => kind === "symbol" ? design.dependencies.libraryResolver.inspectSymbol(libraryId)
      : design.dependencies.libraryResolver.inspectFootprint(libraryId) });
}

export async function toolboxWorkspaceMain(args = process.argv.slice(2)) {
  const options = parseToolboxWorkspaceArgs(args);
  if (options === undefined) { process.stdout.write(toolboxWorkspaceUsage); return; }
  const startup = loadKicadToolboxWorkspace(options);
  let closing: Promise<void> | undefined;
  let stopping = false;
  let transport: StdioServerTransport | undefined;
  const shutdown = (): Promise<void> => closing ??= (async () => {
    stopping = true; const workspace = await startup; await workspace.close(); await transport?.close();
  })();
  const report = (error: unknown) => { process.stderr.write(`[evleda-toolbox-workspace] ${formatNativeToolboxError(error)}\n`); process.exitCode = 1; };
  const stop = () => { void shutdown().catch(report); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop); process.stdin.once("end", stop); process.stdin.once("close", stop);
  try {
    const workspace = await startup;
    if (stopping) { await shutdown(); return; }
    transport = new StdioServerTransport(); await workspace.server.connect(transport);
    const originalClose = transport.onclose;
    transport.onclose = () => { originalClose?.(); stop(); };
    process.stderr.write("[evleda-toolbox-workspace] Connected; native project opens only on request.\n");
  } catch (error) { report(error); if (!stopping) await shutdown().catch(report); }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void toolboxWorkspaceMain().catch(error => { process.stderr.write(`${formatNativeToolboxError(error)}\n${toolboxWorkspaceUsage}`); process.exitCode = 1; });
}

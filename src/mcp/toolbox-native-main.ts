import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect, parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { prepareCopiedKicadProject } from "../cli/pcb-agent.js";
import { loadKicadToolboxNativeProfile } from "./toolbox-native-profile.js";
import { openKicadToolboxNativeHost } from "./toolbox-native-host.js";
import { createKicadToolboxMcpServer, type KicadToolboxMcpServer } from "./toolbox-server.js";
import { validateFreshProjectName } from "../harness/fresh-project.js";

/** Include bounded AggregateError causes so retained cleanup state is diagnosable. */
export const formatNativeToolboxError = (error: unknown): string => inspect(error, { depth: 4, maxArrayLength: 16, maxStringLength: 8192 });

export const nativeToolboxUsage = `Usage: pnpm mcp:toolbox:native --profile <file> --profile-sha256 <sha256> --profile-bytes <bytes> --project-dir <source> --output-dir <empty-output> --board <filename.kicad_pcb> [--edit] [--resume]

Fresh: replace --board with --new-project <name> --intent <draft.json> --prompt <original-request>.
For fresh designs, --project-dir identifies the separate input folder containing the draft.
Resume: use --new-project <same-name> --resume without --intent or --prompt; the saved bundle remains authoritative.

Uses pinned native sections; fresh designs additionally require approved libraries and deepRules.
Opens an isolated copied or newly prepared project in KiCad; never edits the source inputs.
CAD tools are read-only unless --edit is explicitly supplied by the host.
No provider/model configuration or separate UI is required. Fresh drafts are deterministically compiled.
Output is MCP stdio; diagnostics go to stderr. Close the connection to close owned native processes.
`;

export function parseNativeToolboxArgs(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    profile: { type: "string" }, "profile-sha256": { type: "string" }, "profile-bytes": { type: "string" },
    "project-dir": { type: "string" }, "output-dir": { type: "string" }, board: { type: "string" },
    "new-project": { type: "string" }, intent: { type: "string" }, prompt: { type: "string" },
    edit: { type: "boolean", default: false }, resume: { type: "boolean", default: false }, help: { type: "boolean" },
  } });
  if (values.help) return undefined;
  for (const key of ["profile", "profile-sha256", "profile-bytes", "project-dir", "output-dir"] as const) {
    if (!values[key]?.trim()) throw new Error(`Missing --${key}.`);
  }
  const digest = values["profile-sha256"]!;
  const bytes = values["profile-bytes"]!;
  if (!/^[0-9a-f]{64}$/u.test(digest) || !/^[1-9][0-9]*$/u.test(bytes) || !Number.isSafeInteger(Number(bytes))) {
    throw new Error("Native toolbox profile requires an exact SHA-256 and positive byte count.");
  }
  const freshName = values["new-project"] === undefined ? undefined : validateFreshProjectName(values["new-project"]);
  if (freshName !== undefined && values.board !== undefined) throw new Error("Fresh startup cannot also select --board.");
  if (freshName !== undefined && values.resume && (values.intent !== undefined || values.prompt !== undefined)) {
    throw new Error("Fresh resume uses the saved bundle; omit --intent and --prompt.");
  }
  if (freshName !== undefined && !values.resume && (!values.intent?.trim() || !values.prompt?.trim())) {
    throw new Error("New fresh startup requires --intent and --prompt.");
  }
  if (freshName === undefined && (values.intent !== undefined || values.prompt !== undefined)) throw new Error("--intent and --prompt require --new-project.");
  const board = freshName === undefined ? values.board : `${freshName}.kicad_pcb`;
  if (board === undefined) throw new Error("Missing --board or --new-project.");
  if (path.basename(board) !== board || /[\\/\u0000-\u001f]/u.test(board) || path.extname(board).toLowerCase() !== ".kicad_pcb") {
    throw new Error("--board must be one PCB filename in the copied project root.");
  }
  return Object.freeze({
    profile: { path: path.resolve(values.profile!), contentIdentity: { algorithm: "sha256" as const, digest, size: Number(bytes) } },
    projectDir: path.resolve(values["project-dir"]!), outputDir: path.resolve(values["output-dir"]!), board,
    edit: values.edit, resume: values.resume,
    ...(freshName === undefined ? {} : { fresh: Object.freeze({ name: freshName,
      ...(values.resume ? {} : { intentPath: path.resolve(values.intent!), originalPrompt: values.prompt! }) }) }),
  });
}

/** Native startup shared by stdio and an in-process host; owns the copied project session. */
export async function createNativeToolbox(args: NonNullable<ReturnType<typeof parseNativeToolboxArgs>>): Promise<KicadToolboxMcpServer> {
  if (args.fresh !== undefined) {
    const { createFreshNativeToolbox } = await import("./toolbox-fresh-main.js");
    return createFreshNativeToolbox({ ...args, fresh: args.fresh });
  }
  const prepared = await prepareCopiedKicadProject({ projectDir: args.projectDir, outputDir: args.outputDir,
    mode: args.resume ? "resume" : "prepare" });
  const native = await loadKicadToolboxNativeProfile({ profile: args.profile,
    sourceRoot: prepared.sourceProjectPath, outputRoot: prepared.outputPath });
  const cad = await openKicadToolboxNativeHost({ runtime: native.bridge, suite: native.editorSuite,
    prepared, pcbPath: path.join(prepared.isolatedProjectPath, args.board),
    termination: native.termination, environment: native.environment, launcher: native.editorLauncher, createCliAdapter: native.createCliAdapter,
    ...(native.referenceCoverage === undefined ? {} : { referenceCoverage: native.referenceCoverage }) });
  try { return createKicadToolboxMcpServer({ cad, access: args.edit ? "edit" : "read-only",
    ...(native.transmissionLine === undefined ? {} : { transmissionLine: native.transmissionLine }) }); }
  catch (error) {
    try { await cad.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Toolbox creation failed and native cleanup was not confirmed."); }
    throw error;
  }
}

export async function nativeToolboxMain(args = process.argv.slice(2)): Promise<void> {
  const options = parseNativeToolboxArgs(args);
  if (options === undefined) { process.stdout.write(nativeToolboxUsage); return; }
  let stopping = false;
  let closing: Promise<void> | undefined;
  let wire: StdioServerTransport | undefined;
  const report = (error: unknown): void => {
    process.stderr.write(`[evleda-toolbox-native] ${formatNativeToolboxError(error)}\n`);
    process.exitCode = 1;
  };
  const startup = createNativeToolbox(options);
  const shutdown = (): Promise<void> => closing ??= (async () => {
    stopping = true;
    const toolbox = await startup;
    // Drain the operation/save queue before closing the protocol connection.
    await toolbox.close();
    await wire?.close();
  })();
  const stop = (): void => { void shutdown().catch(report); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  try {
    const toolbox = await startup;
    if (stopping) { await shutdown(); return; }
    wire = new StdioServerTransport();
    // One native owner and one protocol instance for this connection.
    await toolbox.server.connect(wire);
    const onclose = wire.onclose;
    wire.onclose = () => { onclose?.(); stop(); };
    process.stderr.write("[evleda-toolbox-native] Connected to isolated PCB project.\n");
  } catch (error) { report(error); if (!stopping) await shutdown().catch(report); }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void nativeToolboxMain().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${nativeToolboxUsage}`); process.exitCode = 1; });
}

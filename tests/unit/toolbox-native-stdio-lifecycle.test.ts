import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ prepare: vi.fn(), profile: vi.fn(), host: vi.fn(), server: vi.fn(), transportClose: vi.fn(), transportCreated: vi.fn() }));
vi.mock("../../src/cli/pcb-agent.js", () => ({ prepareCopiedKicadProject: seams.prepare }));
vi.mock("../../src/mcp/toolbox-native-profile.js", () => ({ loadKicadToolboxNativeProfile: seams.profile }));
vi.mock("../../src/mcp/toolbox-native-host.js", () => ({ openKicadToolboxNativeHost: seams.host }));
vi.mock("../../src/mcp/toolbox-server.js", () => ({ createKicadToolboxMcpServer: seams.server }));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ StdioServerTransport: class {
  onclose?: () => void;
  constructor() { seams.transportCreated(); }
  close = seams.transportClose;
} }));
import { nativeToolboxMain, createNativeToolbox, parseNativeToolboxArgs } from "../../src/mcp/toolbox-native-main.js";

const args = ["--profile", "profile.json", "--profile-sha256", "a".repeat(64), "--profile-bytes", "17",
  "--project-dir", "source", "--output-dir", "output", "--board", "board.kicad_pcb"];
let originalExitCode: typeof process.exitCode;
beforeEach(() => { vi.resetAllMocks(); originalExitCode = process.exitCode; });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode; });

function fixture() {
  const callbacks = new Map<string, () => void>();
  const processOnce = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGINT" || event === "SIGTERM") { callbacks.set(event, listener as () => void); return process; }
    return processOnce(event, listener);
  });
  const stdinOnce = process.stdin.once.bind(process.stdin);
  vi.spyOn(process.stdin, "once").mockImplementation((event, listener) => {
    if (event === "end" || event === "close") { callbacks.set(event, listener as () => void); return process.stdin; }
    return stdinOnce(event, listener);
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  seams.prepare.mockResolvedValue({ sourceProjectPath: "source", outputPath: "output", isolatedProjectPath: "output/copy" });
  seams.profile.mockResolvedValue({ bridge: {}, editorSuite: {}, termination: {}, environment: {} });
  seams.host.mockResolvedValue({ close: vi.fn() });
  const toolbox = { server: { connect: vi.fn().mockResolvedValue(undefined) }, close: vi.fn().mockResolvedValue(undefined) };
  seams.server.mockReturnValue(toolbox);
  return { callbacks, stderr, toolbox };
}

describe("native toolbox stdio lifecycle", () => {
  it("forwards optional reference coverage into the copied native host", async () => {
    fixture(); const referenceCoverage = { calculate: vi.fn() };
    seams.profile.mockResolvedValue({ bridge: {}, editorSuite: {}, termination: {}, environment: {}, referenceCoverage });
    await createNativeToolbox(parseNativeToolboxArgs(args)!);
    expect(seams.host).toHaveBeenCalledWith(expect.objectContaining({ referenceCoverage }));
    expect(seams.server.mock.calls[0]![0]).not.toHaveProperty("referenceCoverage");
  });
  it("reports uncertain native cleanup after protocol connection failure", async () => {
    const f = fixture();
    f.toolbox.server.connect.mockRejectedValue(new Error("protocol connection failed"));
    f.toolbox.close.mockRejectedValue(new Error("native cleanup unconfirmed"));
    await nativeToolboxMain(args);
    const diagnostics = f.stderr.mock.calls.map(call => String(call[0])).join("");
    expect(diagnostics).toContain("protocol connection failed");
    expect(diagnostics).toContain("native cleanup unconfirmed");
    expect(process.exitCode).toBe(1);
    expect(f.toolbox.close).toHaveBeenCalledOnce();
  });

  it("closes the native owner without connecting stdio when EOF arrives during startup", async () => {
    const f = fixture();
    let ready!: (value: object) => void;
    seams.host.mockReturnValue(new Promise(resolve => { ready = resolve; }));
    const main = nativeToolboxMain(args);
    f.callbacks.get("end")!();
    await vi.waitFor(() => expect(seams.host).toHaveBeenCalledOnce());
    ready({ close: vi.fn() });
    await main;
    expect(f.toolbox.close).toHaveBeenCalledOnce();
    expect(f.toolbox.server.connect).not.toHaveBeenCalled();
    expect(seams.transportCreated).not.toHaveBeenCalled();
  });

  it("awaits native operation drain before closing wire and shares repeated stop requests", async () => {
    const f = fixture();
    let drained!: () => void;
    f.toolbox.close.mockReturnValue(new Promise<void>(resolve => { drained = resolve; }));
    await nativeToolboxMain(args);
    f.callbacks.get("end")!();
    f.callbacks.get("SIGTERM")!();
    await vi.waitFor(() => expect(f.toolbox.close).toHaveBeenCalledOnce());
    expect(seams.transportClose).not.toHaveBeenCalled();
    drained();
    await vi.waitFor(() => expect(seams.transportClose).toHaveBeenCalledOnce());
    expect(f.toolbox.close).toHaveBeenCalledOnce();
  });
});

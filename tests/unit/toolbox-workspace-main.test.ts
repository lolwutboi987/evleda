import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const seams = vi.hoisted(() => ({ native: vi.fn(), design: vi.fn(), store: vi.fn(), workspace: vi.fn(), reference: vi.fn() }));
vi.mock("node:fs/promises", () => ({ realpath: async (value: string) => value }));
vi.mock("../../src/flux/production-composition.js", () => ({ readKicadNativeProfile: seams.native }));
vi.mock("../../src/mcp/toolbox-fresh-profile.js", () => ({ loadKicadToolboxFreshProfile: seams.design }));
vi.mock("../../src/mcp/toolbox-workspace-store.js", () => ({ createToolboxWorkspaceStore: seams.store }));
vi.mock("../../src/mcp/toolbox-workspace.js", () => ({ createKicadToolboxWorkspace: seams.workspace }));
vi.mock("../../src/mcp/toolbox-native-main.js", () => ({ formatNativeToolboxError: String }));
vi.mock("../../src/integrations/kicad-reference-coverage.js", () => ({ createReferenceCoverageCalculator: seams.reference }));
import { parseToolboxWorkspaceArgs, loadKicadToolboxWorkspace } from "../../src/mcp/toolbox-workspace-main.js";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const args = ["--profile", "profile.json", "--profile-sha256", "a".repeat(64), "--profile-bytes", "123", "--workspace-root", "workspace"];
describe("workspace startup arguments", () => {
  it("protects the optional reference helper and defers its calculator until project startup", async () => {
    const root = path.resolve("workspace-profile-fixture"), at = (...parts: string[]) => path.join(root, ...parts);
    const pin = { algorithm: "sha256", digest: "a".repeat(64), size: 1 };
    seams.native.mockResolvedValue({ path: at("profile.json"), kicadToolchain: { binRoot: at("kicad", "bin") },
      kicadReferenceCoverage: { path: at("reference", "helper.exe"), identity: pin },
      kicadMcpRuntime: { runtimeBundle: { root: at("runtime"), manifest: { path: at("runtime", "manifest.json") } },
        lock: { path: at("runtime", "lock") }, processTreeSupervision: { terminator: { path: at("system", "taskkill.exe"), identity: pin } },
        runtimeParentRoot: at("private"), ipcSocketParentRoot: at("ipc") } });
    seams.design.mockResolvedValue({ libraryEnvironment: { KICAD10_SYMBOL_DIR: at("kicad", "share", "kicad", "symbols"),
      KICAD10_FOOTPRINT_DIR: at("kicad", "share", "kicad", "footprints") }, protectedRoots: [], dependencies: {}, deepRuleSelectionOptions: {} });
    seams.store.mockResolvedValue({}); seams.workspace.mockReturnValue({ server: "fixture" });
    vi.stubEnv("SYSTEMROOT", at("system")); vi.stubEnv("WINDIR", at("system"));
    await loadKicadToolboxWorkspace(parseToolboxWorkspaceArgs(args)!);
    expect(seams.store.mock.calls[0]![0].protectedRoots).toContain(at("reference"));
    expect(seams.reference).not.toHaveBeenCalled();
    expect(seams.workspace.mock.calls[0]![0]).not.toHaveProperty("referenceCoverage");
  });
  it("requires only installation-level profile/root and explicit edit access", () => {
    expect(parseToolboxWorkspaceArgs(args)).toMatchObject({ workspaceRoot: path.resolve("workspace"), access: "read-only" });
    expect(parseToolboxWorkspaceArgs([...args, "--edit"])?.access).toBe("edit");
    expect(parseToolboxWorkspaceArgs(["--help"])).toBeUndefined();
  });
  it("rejects missing pins and per-project or provider arguments", () => {
    expect(() => parseToolboxWorkspaceArgs([])).toThrow("Missing --profile");
    for (const extra of [["--intent", "draft.json"], ["--board", "board.kicad_pcb"], ["--provider", "model"]]) {
      expect(() => parseToolboxWorkspaceArgs([...args, ...extra])).toThrow();
    }
    expect(() => parseToolboxWorkspaceArgs(args.map(value => value === "123" ? "1.5" : value))).toThrow("exact SHA-256");
  });
});

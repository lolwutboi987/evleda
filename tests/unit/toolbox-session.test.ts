import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KicadMcpTerminationUncertainError, type KicadMcpBoundSessionAuthority } from "../../src/integrations/kicad-mcp-session.js";
import { bindKicadStartupEvidence, captureKicadStartupFailure } from "../../src/integrations/kicad-startup-diagnostic.js";
import type { KicadHarnessToolsOptions } from "../../src/harness/kicad-tools.js";

const seams = vi.hoisted(() => ({ initialize: vi.fn(), fingerprint: vi.fn(), create: vi.fn() }));
vi.mock("../../src/cli/pcb-agent.js", () => ({
  initializeIsolatedKicadProject: seams.initialize,
  nativeProjectFingerprint: seams.fingerprint,
}));
vi.mock("../../src/harness/kicad-tools.js", () => ({
  KICAD_HARNESS_TOOL_NAMES: ["pcb_save", "kicad_set_project"],
  createKicadHarnessTools: seams.create,
}));
import { openKicadToolboxSession } from "../../src/mcp/toolbox-session.js";

const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-toolbox-session-"));
  roots.push(root);
  const pcbPath = path.join(root, "board.kicad_pcb");
  await writeFile(pcbPath, "(kicad_pcb)");
  const identity = { schemaVersion: "test", digest: "authority" };
  const session = {
    identity: { launch: { sessionAuthorityIdentity: identity } },
    assertActivePcb: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const connect = vi.fn().mockResolvedValue(session);
  const disposeUnused = vi.fn().mockResolvedValue("disposed");
  const authority = { identity, semanticIdentity: identity, connect, disposeUnused } as unknown as KicadMcpBoundSessionAuthority;
  const prepared = { sourceProjectPath: `${root}-source`, isolatedProjectPath: root, outputPath: root, reportPath: path.join(root, "report.json") };
  seams.create.mockReturnValue({ tools: [] });
  return { input: { authority, prepared, pcbPath }, session, connect, disposeUnused };
}

describe("host-owned copied-project toolbox session", () => {
  it("retains bound connector diagnostics through the real wrapper when unused cleanup fails", async () => {
    const f = await fixture();
    const primary = captureKicadStartupFailure(Object.assign(new Error("sk-primary"), { code: -32602 }), "mcp-catalog");
    f.connect.mockRejectedValue(bindKicadStartupEvidence(new Error("sk-wrapper"), primary));
    f.disposeUnused.mockRejectedValue(Object.assign(new Error("sk-cleanup"), { code: "EPERM" }));
    const error = await openKicadToolboxSession(f.input).catch(value => value);
    expect(error).toBeInstanceOf(KicadMcpTerminationUncertainError);
    const captured = captureKicadStartupFailure(error, "session-connect");
    expect(captured.failure).toBe(primary.failure);
    expect(captured.cleanup).toEqual([{ stage: "toolbox-session-cleanup", status: "unconfirmed", cause: { category: "native-error", code: "EPERM" } }]);
    expect(inspect(error, { depth: 8 })).not.toContain("sk-");
  });
  it("binds the fixed project and authority, installs saved-source verification, and closes once", async () => {
    const fixtureValue = await fixture();
    const { input, session, connect } = fixtureValue;
    const connected = await openKicadToolboxSession(input);
    expect(connect).toHaveBeenCalledWith({ workspaceRoot: input.prepared.outputPath,
      projectRoot: input.prepared.isolatedProjectPath, outputRoot: path.join(input.prepared.outputPath, ".evleda-mcp-output"),
      mode: "write", isolatedWorkingCopy: { canonicalProjectRoot: input.prepared.sourceProjectPath },
      requiredTools: ["kicad_set_project", "pcb_save"] });
    expect(seams.initialize).toHaveBeenCalledOnce();
    expect(session.assertActivePcb).toHaveBeenCalledWith(input.pcbPath);
    const options = seams.create.mock.calls[0]![1] as KicadHarnessToolsOptions;
    seams.fingerprint.mockResolvedValue("before");
    expect(await options.capturePersistedMutationBaseline!()).toBe("before");
    expect(await options.verifyPersistedMutation!("before")).toBe(false);
    seams.fingerprint.mockResolvedValue("after");
    expect(await options.verifyPersistedMutation!("before")).toBe(true);
    expect(await options.verifyPersistedMutation!()).toBe(false);
    await Promise.all([connected.close(), connected.close()]);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("closes a mismatched connected authority before exposing tools", async () => {
    const { input, session } = await fixture();
    session.identity.launch.sessionAuthorityIdentity = { schemaVersion: "test", digest: "wrong" };
    await expect(openKicadToolboxSession(input)).rejects.toThrow("host-owned write authority");
    expect(session.close).toHaveBeenCalledOnce();
    expect(seams.create).not.toHaveBeenCalled();
  });

  it("closes when the live editor does not have the exact board", async () => {
    const { input, session } = await fixture();
    session.assertActivePcb.mockRejectedValue(new Error("wrong live PCB"));
    await expect(openKicadToolboxSession(input)).rejects.toThrow("wrong live PCB");
    expect(session.close).toHaveBeenCalledOnce();
    expect(seams.create).not.toHaveBeenCalled();
  });

  it("rejects out-of-project documents and releases unused authority", async () => {
    const { input, connect, disposeUnused } = await fixture();
    const other = await fixture();
    await expect(openKicadToolboxSession({ ...input, pcbPath: other.input.pcbPath })).rejects.toThrow("within its isolated project");
    expect(connect).not.toHaveBeenCalled();
    expect(disposeUnused).toHaveBeenCalledOnce();
  });

  it("preserves teardown failure instead of hiding uncertain cleanup", async () => {
    const { input, session } = await fixture();
    seams.initialize.mockRejectedValue(new Error("initialization failed"));
    session.close.mockRejectedValue(new Error("termination uncertain"));
    const error = await openKicadToolboxSession(input).catch(value => value);
    expect(error).toBeInstanceOf(KicadMcpTerminationUncertainError);
    expect(captureKicadStartupFailure(error, "session-connect")).toMatchObject({ failure: { stage: "session-connect", cause: { category: "native-error" } },
      cleanup: [{ stage: "toolbox-session-cleanup", status: "unconfirmed" }] });
    expect(seams.create).not.toHaveBeenCalled();
  });
});

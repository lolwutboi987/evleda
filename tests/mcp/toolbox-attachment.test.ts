import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createKicadToolboxMcpServer, type KicadToolboxServerOptions } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import type { HarnessToolCall } from "../../src/harness/contracts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function cad(name: string) {
  const execute = vi.fn(async (call: HarnessToolCall) => ({ toolCallId: call.id, content: JSON.stringify({ project: name }) }));
  const save = vi.fn(async (call: HarnessToolCall) => ({ toolCallId: call.id, content: "saved" }));
  const close = vi.fn(async () => {});
  const binding = { tools: { tools: ["pcb_get_tracks", "pcb_add_track", "pcb_save", "evleda_get_live_pcb_document"].map(tool => ({
    name: tool, description: tool, inputSchema: { type: "object", properties: {}, additionalProperties: false },
  })), execute, internal: { execute, saveAfterMutation: save } }, assertCurrent: vi.fn(async () => {}),
    captureSources: vi.fn(async () => name), close } as unknown as ConnectedKicadToolbox;
  return { binding, execute, save, close };
}
async function connect(options: KicadToolboxServerOptions = {}) {
  const toolbox = createKicadToolboxMcpServer(options);
  const client = new Client({ name: "attachment-test", version: "1" });
  const toolsChanged = vi.fn(), resourcesChanged = vi.fn();
  client.setNotificationHandler("notifications/tools/list_changed", toolsChanged);
  client.setNotificationHandler("notifications/resources/list_changed", resourcesChanged);
  const [left, right] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(right); await client.connect(left);
  return { toolbox, client, toolsChanged, resourcesChanged, close: async () => { await client.close(); await toolbox.close(); } };
}

describe("host-only dynamic CAD attachment", () => {
  it("notifies an already-connected SDK client and preserves guidance and calculator tools", async () => {
    const calculator = { calculate: vi.fn() } as unknown as NonNullable<KicadToolboxServerOptions["transmissionLine"]>;
    const f = await connect({ transmissionLine: calculator });
    try {
      expect(f.toolbox.getCadState()).toBe("absent");
      const initial = (await f.client.listTools()).tools.map(tool => tool.name);
      expect(initial).not.toContain("pcb_get_tracks"); expect(initial).not.toContain("attachCad");
      const first = cad("first");
      f.toolbox.attachCad({ cad: first.binding, access: "edit", designContext: () => ({ project: "first" }) });
      await vi.waitFor(() => expect(f.toolsChanged).toHaveBeenCalled());
      const attached = (await f.client.listTools()).tools.map(tool => tool.name);
      expect(attached).toContain("pcb_add_track"); expect(attached).not.toContain("pcb_save"); expect(attached).not.toContain("evleda_get_live_pcb_document");
      expect((await f.client.callTool({ name: "evleda_design_context", arguments: {} })).structuredContent).toEqual({ project: "first" });
      const mutation = await f.client.callTool({ name: "pcb_add_track", arguments: {} });
      expect(mutation.isError).not.toBe(true); expect(first.save).toHaveBeenCalledOnce();
      expect(() => f.toolbox.attachCad({ cad: cad("other").binding })).toThrow("confirmed teardown");
      expect(() => f.toolbox.detachCad()).toThrow("confirmed native close");
      await f.client.callTool({ name: "evleda_finish_session", arguments: {} });
      expect(f.toolbox.getCadState()).toBe("closed");
      f.toolbox.detachCad();
      expect(f.toolbox.getCadState()).toBe("absent");
      const detached = (await f.client.listTools()).tools.map(tool => tool.name);
      expect(detached).not.toContain("pcb_get_tracks"); expect(detached).toContain("evleda_transmission_line");
      expect((await f.client.callTool({ name: "evleda_rule_topics", arguments: {} })).isError).not.toBe(true);
    } finally { await f.close(); }
  });

  it("drains the old binding and rejects its queued calls rather than dispatching them to a replacement", async () => {
    const f = await connect(); const first = cad("first"), second = cad("second");
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    first.execute.mockImplementationOnce(async call => { await blocked; return { toolCallId: call.id, content: "first" }; });
    try {
      f.toolbox.attachCad({ cad: first.binding });
      const running = f.client.callTool({ name: "pcb_get_tracks", arguments: {} });
      await vi.waitFor(() => expect(first.execute).toHaveBeenCalledOnce());
      const queued = f.client.callTool({ name: "pcb_get_tracks", arguments: {} });
      await new Promise(resolve => setImmediate(resolve));
      const finishing = f.toolbox.finishCad();
      expect(f.toolbox.getCadState()).toBe("finishing");
      expect(() => f.toolbox.attachCad({ cad: second.binding })).toThrow();
      expect(first.close).not.toHaveBeenCalled();
      release(); await running; expect((await queued).isError).toBe(true); await finishing;
      f.toolbox.attachCad({ cad: second.binding });
      const current = await f.client.callTool({ name: "pcb_get_tracks", arguments: {} });
      expect(JSON.stringify(current.structuredContent)).toContain("second");
      expect(first.execute).toHaveBeenCalledOnce(); expect(second.execute).toHaveBeenCalledOnce();
    } finally { release(); await f.close(); }
  });

  it("keeps teardown uncertainty attached and refuses both replacement and detach", async () => {
    const f = await connect(); const first = cad("first"); first.close.mockRejectedValue(new Error("exit unconfirmed"));
    const onFinished = vi.fn();
    f.toolbox.attachCad({ cad: first.binding, onFinished });
    await expect(f.toolbox.finishCad()).rejects.toThrow("exit unconfirmed");
    expect(f.toolbox.getCadState()).toBe("uncertain");
    expect(() => f.toolbox.attachCad({ cad: cad("new").binding })).toThrow();
    expect(() => f.toolbox.detachCad()).toThrow();
    await f.client.close(); await expect(f.toolbox.close()).rejects.toThrow("exit unconfirmed");
    expect(first.close).toHaveBeenCalledOnce();
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("awaits the successful host release callback before admitting another CAD binding", async () => {
    const f = await connect(); const first = cad("first"); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const onFinished = vi.fn(async () => { await waiting; });
    try {
      f.toolbox.attachCad({ cad: first.binding, onFinished });
      const finish = f.client.callTool({ name: "evleda_finish_session", arguments: {} });
      await vi.waitFor(() => expect(onFinished).toHaveBeenCalledOnce());
      expect(f.toolbox.getCadState()).toBe("finishing");
      expect(() => f.toolbox.attachCad({ cad: cad("next").binding })).toThrow();
      release(); expect((await finish).isError).not.toBe(true);
      expect(onFinished).toHaveBeenCalledWith({ nativeSessionClosed: true, checkpointPublished: false, recoveryRequired: false });
      f.toolbox.attachCad({ cad: cad("next").binding }); expect(f.toolbox.getCadState()).toBe("active");
    } finally { release(); await f.close(); }
  });

  it("releases host leases after successful checkpoint once and locks attachment if the callback fails", async () => {
    const f = await connect(); const first = cad("first"); const order: string[] = [];
    first.binding.prepareCheckpoint = async () => { order.push("capture"); return async () => { order.push("publish"); }; };
    first.close.mockImplementation(async () => { order.push("close"); });
    const onFinished = vi.fn(async () => { order.push("finished"); throw new Error("lease release failed"); });
    f.toolbox.attachCad({ cad: first.binding, onFinished });
    const result = await f.client.callTool({ name: "evleda_finish_session", arguments: {} });
    expect(result.isError).toBe(true); expect(order).toEqual(["capture", "close", "publish", "finished"]);
    expect(onFinished).toHaveBeenCalledWith({ nativeSessionClosed: true, checkpointPublished: true, recoveryRequired: false });
    expect(f.toolbox.getCadState()).toBe("uncertain"); expect(() => f.toolbox.attachCad({ cad: cad("next").binding })).toThrow();
    await f.client.close(); await expect(f.toolbox.close()).rejects.toThrow("lease release failed"); expect(onFinished).toHaveBeenCalledOnce();
  });

  it("notifies resource-template additions and retains hash-bound historical SVG after project replacement", async () => {
    const f = await connect(); const first = cad("first"), second = cad("second");
    const root = await mkdtemp(path.join(tmpdir(), "attachment-preview-")); roots.push(root);
    const source = '<svg xmlns="http://www.w3.org/2000/svg"/>'; const identity = contentIdentity(Buffer.from(source));
    const svgPath = path.join(root, "first.svg"); await writeFile(svgPath, source);
    const uri = `evleda://pcb-preview/${identity.digest}/top`;
    first.binding.renderPreview = vi.fn().mockResolvedValue({ source, resourceUri: uri, pcbSvg: { path: svgPath, sha256: identity.digest, sizeBytes: identity.size },
      png: { data: "AA==", mimeType: "image/png", width: 1, height: 1 } });
    try {
      expect((await f.client.listResourceTemplates()).resourceTemplates).not.toEqual(expect.arrayContaining([expect.objectContaining({ uriTemplate: "evleda://pcb-preview/{digest}/{view}" })]));
      f.toolbox.attachCad({ cad: first.binding });
      await vi.waitFor(() => expect(f.resourcesChanged).toHaveBeenCalled());
      expect((await f.client.listResourceTemplates()).resourceTemplates).toEqual(expect.arrayContaining([expect.objectContaining({ uriTemplate: "evleda://pcb-preview/{digest}/{view}" })]));
      const rendered = await f.client.callTool({ name: "evleda_render_board", arguments: { view: "top" } }); expect(rendered.isError).not.toBe(true);
      await f.toolbox.finishCad(); f.toolbox.attachCad({ cad: second.binding });
      expect((await f.client.readResource({ uri })).contents).toEqual([{ uri, mimeType: "image/svg+xml", text: source }]);
      expect(second.execute).not.toHaveBeenCalled();
      await writeFile(svgPath, "tampered"); await expect(f.client.readResource({ uri })).rejects.toThrow("changed");
    } finally { await f.close(); }
  });
});

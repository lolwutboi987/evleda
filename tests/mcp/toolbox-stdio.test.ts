import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, it } from "vitest";

it("starts the real standalone toolbox and retrieves verified guidance over stdio", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href, path.join(root, "src/mcp/toolbox-main.ts")],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "toolbox-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const status = await client.callTool({ name: "evleda_toolbox_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ access: "guidance-only", cadConnected: false });
    const topics = await client.callTool({ name: "evleda_rule_topics", arguments: {} });
    expect(topics.structuredContent).toMatchObject({ ruleCount: 1773 });
    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(17);
    const guide = await client.readResource({ uri: resources.resources[0]!.uri });
    expect((guide.contents[0] as { text: string }).text.length).toBeGreaterThan(1000);
  } finally {
    await client.close();
    await transport.close();
  }
}, 20_000);

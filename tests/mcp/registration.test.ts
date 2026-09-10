import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OPERATION_NAMES } from "../../src/contracts/operations.js";
import { createMcpServer, MCP_TOOL_DEFINITIONS } from "../../src/mcp/server.js";
import { disposeApplicationRoots, makeApplication, reviewer } from "../application/helpers.js";

afterEach(disposeApplicationRoots);

describe("MCP v2 registration", () => {
  it("declares all 14 tools once with closed-world annotations", () => {
    expect(MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(OPERATION_NAMES);
    expect(new Set(MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).size).toBe(14);
    expect(MCP_TOOL_DEFINITIONS.every((tool) => tool.annotations.openWorldHint === false)).toBe(true);
    expect(
      MCP_TOOL_DEFINITIONS.find((tool) => tool.name === "inspect_engineering_practices")
        ?.annotations
    ).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
  });

  it("lists all tools over an in-memory protocol connection and cannot self-approve", async () => {
    const server = createMcpServer(await makeApplication());
    const client = new Client({ name: "evleda-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(OPERATION_NAMES);
    for (const [index, tool] of listed.tools.entries()) {
      const definition = MCP_TOOL_DEFINITIONS[index]!;
      expect(tool.inputSchema).toStrictEqual({
        type: "object",
        ...z.toJSONSchema(definition.inputSchema, { target: "draft-2020-12", io: "input" })
      });
    }

    const result = await client.callTool({
      name: "approve_requirements",
      arguments: {
        runId: "run_nonexistent",
        requirementsDigest: "0".repeat(64),
        actor: reviewer,
        rationale: "Attempted MCP approval",
        expectedRevision: 0,
        idempotencyKey: "mcp-cannot-approve"
      }
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_REQUIRED" }
    });
    await client.close();
    await server.close();
  });

  it("returns an honest read-only engineering diagnostic before the PCB stage runs", async () => {
    const service = await makeApplication();
    const project = await service.createProject({
      name: "MCP engineering inspection",
      idempotencyKey: "mcp-engineering-project-0001"
    });
    const started = await service.startDesignRun({
      projectId: project.project.id,
      prompt:
        "Build a two-channel brushed motor controller for a 7-16.8 V supply at 0.5 A RMS per channel with USB, CAN, UART, I2C, SPI, two quadrature encoders, and SWD.",
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "mcp-engineering-run-0000001"
    });
    const server = createMcpServer(service);
    const client = new Client({ name: "evleda-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({
        name: "inspect_engineering_practices",
        arguments: { runId: started.run.id, findingLimit: 50 }
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        ok: true,
        operation: "inspect_engineering_practices",
        result: {
          disposition: { status: "BLOCKED_DIAGNOSTIC" },
          checks: {
            nativeDrc: { machineStatus: "NOT_RUN" },
            evledaPractice: { machineStatus: "NOT_RUN" }
          }
        }
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

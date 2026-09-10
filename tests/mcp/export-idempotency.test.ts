import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { BundleExportResult } from "../../src/application/results.js";
import { createMcpServer } from "../../src/mcp/server.js";
import {
  createCompletedRun,
  disposeApplicationRoots,
  makeApplication
} from "../application/helpers.js";

afterEach(disposeApplicationRoots);

describe("MCP bundle export idempotency", () => {
  it("replays the original candidate result after current-state export gates change", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const server = createMcpServer(service);
    const client = new Client({ name: "evleda-export-replay-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const request = {
      name: "export_candidate_bundle",
      arguments: {
        revisionId: completed.headRevision!.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: "mcp-candidate-exact-replay"
      }
    } as const;

    try {
      const first = await client.callTool(request);
      expect(first.isError).not.toBe(true);
      const firstEnvelope = first.structuredContent as unknown as {
        readonly ok: true;
        readonly result: BundleExportResult;
      };
      const afterExport = await service.getRunStatus({ runId: completed.run.id });
      await service.generateBringupPlan({
        revisionId: completed.headRevision!.id,
        expectedRevision: afterExport.run.revision,
        idempotencyKey: "mcp-candidate-advance-head"
      });

      const replay = await client.callTool(request);
      expect(replay.isError).not.toBe(true);
      expect(
        (replay.structuredContent as unknown as { readonly result: BundleExportResult }).result
      ).toStrictEqual(firstEnvelope.result);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

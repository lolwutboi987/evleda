import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createProductionApplicationService,
  resolveProductionApplicationPaths,
} from "../application/factory.js";
import { createMcpServer } from "./server.js";

const main = async (): Promise<void> => {
  const productionPaths = resolveProductionApplicationPaths(process.env, process.cwd());
  const service = await createProductionApplicationService({
    paths: productionPaths,
    environment: process.env,
  });

  serveStdio(() => createMcpServer(service), {
    onerror: (error) => {
      process.stderr.write(`[evleda-mcp] ${error.message}\n`);
    },
  });
};

void main().catch((error: unknown) => {
  process.stderr.write(
    `[evleda-mcp] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

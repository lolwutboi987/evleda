import { createLocalApiServer } from "./server.js";

const main = async (): Promise<void> => {
  const { app, host, port } = await createLocalApiServer(process.env);
  await app.listen({ host, port });
};

void main().catch((error: unknown) => {
  process.stderr.write(`[evleda-api] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalApiServer } from "../../src/api/server.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("local daemon optional Flux composition", () => {
  it("binds the existing daemon with Flux unconfigured and returns a clean 503 only for Flux", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "evleda-no-flux-")); roots.push(dataRoot);
    const environment: NodeJS.ProcessEnv = { ...process.env, EVLEDA_DATA_DIR: dataRoot };
    delete environment.EVLEDA_FLUX_SOURCE_ROOT; delete environment.EVLEDA_FLUX_WORKSPACE_ROOT;
    delete environment.EVLEDA_FLUX_PRODUCTION_PROFILE_PATH;
    delete environment.EVLEDA_FLUX_PRODUCTION_PROFILE_SHA256;
    delete environment.EVLEDA_FLUX_PRODUCTION_PROFILE_SIZE_BYTES;
    const { app } = await createLocalApiServer(environment);
    try {
      const readiness = await app.inject({ method: "GET", url: "/api/v1/flux/readiness" });
      expect(readiness.statusCode).toBe(200);
      expect(readiness.json().result).toEqual({
        schemaVersion: "evleda.flux-readiness.v1",
        configured: false,
        status: "setup_required",
        reasonCodes: ["FLUX_DISABLED"],
        provider: null,
        compiler: null,
        toolchain: null,
        kicadMcpRuntime: null,
        diagnostic: null,
      });
      const response = await app.inject({ method: "GET", url: "/api/v1/flux/sources" });
      expect(response.statusCode).toBe(503);
      expect((response.json() as { error: { message: string } }).error.message).toContain("not configured");
    } finally { await app.close(); }
  });

  it("applies production path validation during daemon composition", async () => {
    await expect(createLocalApiServer({ EVLEDA_DATA_DIR: "relative/data" })).rejects.toThrow(
      /EVLEDA_DATA_DIR.*absolute/iu,
    );
  });

  it("rejects a partial Flux root configuration", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "evleda-partial-flux-")); roots.push(dataRoot);
    await expect(createLocalApiServer({ ...process.env, EVLEDA_DATA_DIR: dataRoot, EVLEDA_FLUX_SOURCE_ROOT: dataRoot, EVLEDA_FLUX_WORKSPACE_ROOT: undefined })).rejects.toThrow("must be configured together");
  });
});

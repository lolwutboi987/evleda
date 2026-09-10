import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProductionApplicationService,
  resolveProductionApplicationPaths,
} from "../../src/application/factory.js";
import { createApprovedRun } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("production application composition", () => {
  it("resolves every production input to an explicit absolute path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-production-paths-"));
    roots.push(root);

    const paths = resolveProductionApplicationPaths({}, root);

    expect(
      [
        paths.dataRoot,
        paths.workspaceRoot,
        paths.snapshotPath,
        paths.sourceRoot,
        paths.referenceDesignRoot,
        paths.kicadWorkRoot,
        paths.kicadExecutablePath,
        ...(paths.kicadExecutableCandidates ?? []),
      ].every((entry) => path.isAbsolute(entry)),
    ).toBe(true);
    expect(paths.referenceDesignRoot).toBe(
      path.join(root, "reference-designs", "robotics-controller-v0"),
    );
    expect(paths.snapshotPath).toBe(
      path.join(paths.referenceDesignRoot, "evidence", "reference-stage-context.v1.json"),
    );
    expect(paths.sourceRoot).toBe(path.join(paths.referenceDesignRoot, "evidence"));
    expect(paths.kicadWorkRoot).toBe(path.join(paths.dataRoot, "kicad-work"));
  });

  it("uses explicit override, user-local, then system KiCad discovery order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-production-discovery-"));
    roots.push(root);
    const localAppData = path.join(root, "LocalAppData");

    const discovered = resolveProductionApplicationPaths({ LOCALAPPDATA: localAppData }, root);
    expect(discovered.kicadExecutableCandidates?.[0]).toBe(
      path.join(localAppData, "Programs", "KiCad", "10.0", "bin", "kicad-cli.exe"),
    );
    expect(discovered.kicadExecutableCandidates?.at(-1)).toBe(
      "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe",
    );

    const explicit = path.join(root, "pinned", "kicad-cli.exe");
    const overridden = resolveProductionApplicationPaths(
      { LOCALAPPDATA: localAppData, EVLEDA_KICAD_CLI: explicit },
      root,
    );
    expect(overridden.kicadExecutableCandidates).toEqual([explicit]);
  });

  it("rejects relative configuration and overlapping immutable/writable roots before creation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-production-invalid-"));
    roots.push(root);

    expect(() =>
      resolveProductionApplicationPaths({ EVLEDA_DATA_DIR: "relative/data" }, root),
    ).toThrow(/EVLEDA_DATA_DIR.*absolute/iu);
    const overlapping = resolveProductionApplicationPaths(
      {
        EVLEDA_REFERENCE_DESIGN_ROOT: path.join(root, "reference"),
        EVLEDA_KICAD_WORK_ROOT: path.join(root, "reference", "work"),
      },
      root,
    );
    await expect(
      createProductionApplicationService({ paths: overlapping, environment: {} }),
    ).rejects.toThrow(/must not overlap/iu);
  });

  it("starts without immutable evidence but blocks the first candidate stage when no trust root is configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-production-provider-"));
    roots.push(root);
    const referenceDesignRoot = path.join(root, "missing-reference");
    const paths = {
      dataRoot: path.join(root, "data"),
      workspaceRoot: path.join(root, "data", "workspaces"),
      snapshotPath: path.join(root, "evidence", "missing-context.json"),
      sourceRoot: path.join(root, "evidence", "sources"),
      referenceDesignRoot,
      kicadWorkRoot: path.join(root, "data", "kicad-work"),
      kicadExecutablePath: path.join(root, "missing-kicad-cli.exe"),
    };
    const service = await createProductionApplicationService({ paths, environment: {} });
    await service.initialize();
    const approved = await createApprovedRun(service);

    const status = await service.resumeRun({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "production-provider-missing-snapshot",
    });

    expect(status.run.state).toBe("blocked");
    expect(status.currentStage).toBe("system_architecture");
    expect(status.blockers).toEqual([
      expect.objectContaining({
        code: "POLICY_DENIED",
        stage: "system_architecture",
        retryable: true,
      }),
    ]);
  });

  it("routes both executable entrypoints through production composition", async () => {
    const [apiMain, apiServer, mcpMain] = await Promise.all([
      readFile(path.resolve("src/api/main.ts"), "utf8"),
      readFile(path.resolve("src/api/server.ts"), "utf8"),
      readFile(path.resolve("src/mcp/main.ts"), "utf8"),
    ]);

    expect(apiMain).toContain("createLocalApiServer(process.env)");
    expect(apiMain).not.toContain("createDefaultApplicationService");

    for (const source of [apiServer, mcpMain]) {
      expect(source).toContain("createProductionApplicationService");
      expect(source).toContain("resolveProductionApplicationPaths");
      expect(source).not.toContain("createDefaultApplicationService");
    }
  });
});

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../..", import.meta.url));

describe("native runtime CLI diagnostics", () => {
  it.each(["true", "false"])("keeps missing-runtime verification failing when GITHUB_ACTIONS=%s", githubActions => {
    const missing = path.join(os.tmpdir(), `evleda-unprovisioned-runtime-${randomUUID()}`);
    const result = spawnSync(process.execPath, ["scripts/verify-kicad-inspection-runtime.mjs"], {
      cwd: repository,
      env: { ...process.env, GITHUB_ACTIONS: githubActions,
        EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT: path.join(missing, "runtime"),
        EVLEDA_KICAD_INSPECTION_RUNTIME_MANIFEST: path.join(missing, "manifest.json") },
      encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Destination runtime manifest is unavailable.");
    expect(result.stderr).toContain("ENOENT");
    const annotations = result.stderr.split(/\r?\n/u).filter(line => line.startsWith("::error "));
    if (githubActions === "true") {
      expect(annotations).toHaveLength(1);
      expect(annotations[0]).toContain("title=Native KiCad runtime not provisioned");
      expect(annotations[0]).toContain("Verification was not skipped.");
      expect(annotations[0]).not.toContain(missing);
    } else expect(annotations).toEqual([]);
  });
});

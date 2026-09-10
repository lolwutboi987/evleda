import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const guardPath = fileURLToPath(new URL("../../scripts/verify-no-source-adjacent-emits.mjs", import.meta.url));
const owned = new Set<string>();

afterEach(async () => {
  await Promise.all([...owned].map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
    owned.delete(directory);
  }));
});

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await writeFile(file, JSON.stringify(value), "utf8");
};

const fixture = async (additionalRootSources: readonly string[] = []): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-source-emit-guard-"));
  owned.add(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "ui", "src"), { recursive: true });
  await writeJson(path.join(root, "tsconfig.json"), {
    compilerOptions: { jsx: "preserve", noEmit: true },
    include: ["src/**/*"]
  });
  await writeJson(path.join(root, "tsconfig.build.json"), {
    extends: "./tsconfig.json",
    compilerOptions: { noEmit: false, outDir: "dist" },
    include: ["src/**/*"]
  });
  await writeJson(path.join(root, "ui", "tsconfig.json"), {
    compilerOptions: { jsx: "preserve", noEmit: true },
    include: ["src/**/*"]
  });
  await writeFile(path.join(root, "src", "clean.ts"), "export const clean = true;\n", "utf8");
  for (const source of additionalRootSources) {
    await writeFile(path.join(root, "src", source), "export const value = true;\n", "utf8");
  }
  await writeFile(path.join(root, "ui", "src", "view.tsx"), "export const view = <div />;\n", "utf8");
  return root;
};

const runGuard = async (root: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guardPath, "--root", root], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => { resolve({ code, stdout, stderr }); });
  });

describe("source-adjacent emit guard", () => {
  it("passes a clean configured TypeScript source set without writing files", async () => {
    const root = await fixture();
    const source = path.join(root, "src", "clean.ts");
    const before = await readFile(source, "utf8");

    const result = await runGuard(root);

    expect(result).toEqual({
      code: 0,
      stdout: "Source-adjacent emit guard passed for 2 configured TypeScript source(s).\n",
      stderr: ""
    });
    expect(await readFile(source, "utf8")).toBe(before);
  });

  it("reports every existing output deterministically and leaves violations untouched", async () => {
    const root = await fixture(["alpha.ts", "zeta.ts"]);
    const declaration = path.join(root, "src", "alpha.d.ts");
    const javascript = path.join(root, "src", "zeta.js");
    await writeFile(declaration, "export declare const value: true;\n", "utf8");
    await writeFile(javascript, "export const value = false;\n", "utf8");

    const first = await runGuard(root);
    const second = await runGuard(root);

    expect(first.code).toBe(1);
    expect(first.stdout).toBe("");
    expect(first.stderr).toBe(second.stderr);
    expect(first.stderr.indexOf("  src/alpha.d.ts\n")).toBeGreaterThan(-1);
    expect(first.stderr.indexOf("  src/alpha.d.ts\n")).toBeLessThan(first.stderr.indexOf("  src/zeta.js\n"));
    expect(await readFile(declaration, "utf8")).toBe("export declare const value: true;\n");
    expect(await readFile(javascript, "utf8")).toBe("export const value = false;\n");
  });
});

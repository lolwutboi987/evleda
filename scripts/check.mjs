#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const minimumNode = [24, 19, 0];

const parseVersion = (version) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) throw new Error(`Cannot parse Node.js version: ${version}`);
  return match.slice(1).map(Number);
};

const atLeast = (actual, minimum) => {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
};

const nodeVersion = parseVersion(process.version);
if (!atLeast(nodeVersion, minimumNode)) {
  throw new Error(`Node.js >=${minimumNode.join(".")} is required; received ${process.version}`);
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (packageJson.private !== true) throw new Error("Refusing checks because package.json is not marked private");

const run = (label, command, args) =>
  new Promise((resolve, reject) => {
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, CI: process.env.CI ?? "true" },
      shell: false,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal === null ? `exit ${String(code)}` : `signal ${signal}`})`));
    });
  });

const runNode = (label, args) => run(label, process.execPath, args);
const runPnpmScript = async (script) => {
  if (process.platform === "win32") {
    // Windows cannot execute a .cmd shim through spawn without cmd.exe. The command
    // and script names here are fixed constants; no caller input reaches the shell.
    await run(`pnpm ${script}`, process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", [
      "/d",
      "/s",
      "/c",
      `pnpm run ${script}`
    ]);
  } else {
    await run(`pnpm ${script}`, "pnpm", ["run", script]);
  }
};

try {
  await runNode("deep-rule resource integrity", ["scripts/verify-deep-rule-resources.mjs"]);
  await runNode("deep-rule resource adversarial cases", ["scripts/test-deep-rule-resource-verifier.mjs"]);
  await runNode("documentation contract", ["scripts/verify-docs.mjs"]);
  await runNode("bundle provenance-root fixture", [
    "scripts/verify-bundle.mjs",
    "scripts/fixtures/valid-candidate-bundle"
  ]);
  await runNode("bundle verifier adversarial cases", ["scripts/test-bundle-verifier.mjs"]);
  await runNode("exported bundle integration", [
    "node_modules/tsx/dist/cli.mjs",
    "scripts/test-exported-bundle.ts"
  ]);
  for (const script of ["typecheck", "test", "build"]) await runPnpmScript(script);
  console.log("\nAll local software checks passed.");
  console.log("Passing software or available native-tool checks do not assert fabrication, physical qualification, safety, or release.");
} catch (error) {
  console.error(`\nLocal verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

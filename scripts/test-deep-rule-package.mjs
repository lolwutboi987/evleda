#!/usr/bin/env node

import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  DEEP_RULE_RESOURCE_IDENTITY,
  distDeepRuleResourceDirectory,
  verifyDeepRuleResourceDirectory
} from "./verify-deep-rule-resources.mjs";

const root = path.resolve(import.meta.dirname, "..");
const builtModule = path.resolve(root, "dist", "src", "harness", "deep-rule-catalog.js");
const builtResource = distDeepRuleResourceDirectory();
const originalCwd = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "evleda-deep-rule-package-"));

const assertTemporaryTarget = (target) => {
  const relative = path.relative(temporaryRoot, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Test target is outside its isolated temporary root: ${target}`);
  }
};

const expectLoaderFailure = (label, operation, pattern) => {
  let received;
  try {
    operation();
  } catch (error) {
    received = error;
  }
  if (received === undefined) throw new Error(`${label} unexpectedly loaded`);
  const message = received instanceof Error ? received.message : String(received);
  if (!pattern.test(message)) throw new Error(`${label} failed for the wrong reason: ${message}`);
};

try {
  await verifyDeepRuleResourceDirectory(builtResource);
  await readFile(builtModule);

  const relocatedDist = path.resolve(temporaryRoot, "relocated", "dist");
  const relocatedModuleDirectory = path.resolve(relocatedDist, "src", "harness");
  const relocatedModule = path.resolve(relocatedModuleDirectory, "deep-rule-catalog.js");
  const relocatedResource = path.resolve(relocatedDist, "resources", "deep-pcb-rule-corpus", "v1");
  const cleanCwd = path.resolve(temporaryRoot, "clean-cwd");
  const shadowDirectory = path.resolve(cleanCwd, "docs", "pcb-design-guides");
  for (const target of [relocatedDist, relocatedModuleDirectory, relocatedModule, relocatedResource, cleanCwd, shadowDirectory]) {
    assertTemporaryTarget(target);
  }

  await mkdir(relocatedModuleDirectory, { recursive: true });
  await mkdir(shadowDirectory, { recursive: true });
  await cp(builtModule, relocatedModule);
  await cp(builtResource, relocatedResource, { recursive: true });
  await writeFile(
    path.resolve(shadowDirectory, "rule-catalog.json"),
    '{"schemaVersion":1,"sourceDossiers":[],"rules":[],"shadow":true}\n',
    "utf8"
  );

  process.chdir(cleanCwd);
  const relocated = await import(`${pathToFileURL(relocatedModule).href}?relocation=${Date.now().toString()}`);
  const resolvedResource = relocated.resolvePackagedDeepRuleResourceDirectory();
  if (path.resolve(resolvedResource) !== relocatedResource) {
    throw new Error(`Relocated module resolved ${resolvedResource}, expected ${relocatedResource}`);
  }
  const verified = relocated.loadDeepRuleResource();
  if (verified.resourceIdentity !== DEEP_RULE_RESOURCE_IDENTITY) throw new Error("Relocated resource identity drifted");
  if (verified.catalog.rules.length !== 1_773 || verified.catalog.sourceDossiers.length !== 17) {
    throw new Error("Relocated module did not load the complete packaged corpus");
  }
  if (!verified.catalogPath.startsWith(relocatedResource)) throw new Error("Relocated catalog escaped its packaged resource root");

  const emptyDirectory = path.resolve(relocatedResource, "unmanifested-empty");
  assertTemporaryTarget(emptyDirectory);
  await mkdir(emptyDirectory);
  expectLoaderFailure("relocated resource with an empty directory", () => relocated.loadDeepRuleResource(), /shadow files or directories/iu);
  await rm(emptyDirectory, { recursive: true, force: true });

  const nestedDirectoryRoot = path.resolve(relocatedResource, "docs", "pcb-design-guides", "research", "extra");
  const nestedDirectory = path.resolve(nestedDirectoryRoot, "nested");
  assertTemporaryTarget(nestedDirectoryRoot);
  await mkdir(nestedDirectory, { recursive: true });
  expectLoaderFailure("relocated resource with an extra nested directory", () => relocated.loadDeepRuleResource(), /shadow files or directories/iu);
  await rm(nestedDirectoryRoot, { recursive: true, force: true });

  const rootJunction = path.resolve(temporaryRoot, "relocated-resource-junction");
  assertTemporaryTarget(rootJunction);
  await symlink(relocatedResource, rootJunction, process.platform === "win32" ? "junction" : "dir");
  expectLoaderFailure(
    "relocated resource root junction",
    () => relocated.loadDeepRuleResource(relocated.createDeepRuleResourceProfile(rootJunction, DEEP_RULE_RESOURCE_IDENTITY)),
    /canonical ordinary directory|link, junction, or reparse/iu
  );
  await unlink(rootJunction);

  const descendantTarget = path.resolve(temporaryRoot, "relocated-descendant-junction-target");
  const descendantJunction = path.resolve(relocatedResource, "descendant-junction");
  assertTemporaryTarget(descendantTarget);
  assertTemporaryTarget(descendantJunction);
  await mkdir(descendantTarget);
  await symlink(descendantTarget, descendantJunction, process.platform === "win32" ? "junction" : "dir");
  expectLoaderFailure("relocated resource descendant junction", () => relocated.loadDeepRuleResource(), /links, junctions, or reparse/iu);
  await unlink(descendantJunction);

  console.log(`Relocated deep-rule package passed clean-cwd/shadow, exact-directory, and root/descendant-junction checks: ${verified.resourceIdentity}`);
} catch (error) {
  console.error(`Relocated deep-rule package test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  process.chdir(originalCwd);
  const temporaryParent = path.resolve(tmpdir());
  if (path.dirname(temporaryRoot) !== temporaryParent || !path.basename(temporaryRoot).startsWith("evleda-deep-rule-package-")) {
    throw new Error(`Refusing to remove unexpected temporary directory: ${temporaryRoot}`);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

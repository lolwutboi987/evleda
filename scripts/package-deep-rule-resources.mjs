#!/usr/bin/env node

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  distDeepRuleResourceDirectory,
  sourceDeepRuleResourceDirectory,
  verifyDeepRuleResourceDirectory
} from "./verify-deep-rule-resources.mjs";

const source = sourceDeepRuleResourceDirectory();
const target = distDeepRuleResourceDirectory();
const distRoot = path.resolve(import.meta.dirname, "..", "dist");
const targetFromDist = path.relative(distRoot, target);

if (
  targetFromDist === ""
  || targetFromDist === ".."
  || targetFromDist.startsWith(`..${path.sep}`)
  || path.isAbsolute(targetFromDist)
) {
  throw new Error(`Refusing to replace deep-rule resource outside dist: ${target}`);
}

try {
  const sourceResult = await verifyDeepRuleResourceDirectory(source);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  const targetResult = await verifyDeepRuleResourceDirectory(target);
  if (sourceResult.resourceIdentity !== targetResult.resourceIdentity) {
    throw new Error("Packaged deep-rule resource identity differs from source");
  }
  console.log(`Packaged deep-rule resource ${targetResult.resourceIdentity} at ${target}`);
} catch (error) {
  console.error(`Deep-rule resource packaging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

#!/usr/bin/env node

import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  sourceDeepRuleResourceDirectory,
  verifyDeepRuleResourceDirectory
} from "./verify-deep-rule-resources.mjs";

const source = sourceDeepRuleResourceDirectory();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "evleda-deep-rule-verifier-"));
let passed = 0;

const copyFor = async (name) => {
  const target = path.resolve(temporaryRoot, name, "resource");
  const back = path.relative(temporaryRoot, target);
  if (back === "" || back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error(`Fixture target escaped temporary root: ${target}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  return target;
};

const rejects = async (label, operation, pattern) => {
  await assert.rejects(operation, pattern, label);
  passed += 1;
};

try {
  const valid = await verifyDeepRuleResourceDirectory(source);
  assert.equal(valid.ruleCount, 1_773);
  assert.equal(valid.dossierCount, 17);
  passed += 1;

  const missing = await copyFor("missing");
  await unlink(path.resolve(missing, "docs", "pcb-design-guides", "research", "16-component-placement.md"));
  await rejects("missing dossier", () => verifyDeepRuleResourceDirectory(missing), /missing, unexpected, or shadow files/iu);

  const dossierTamper = await copyFor("dossier-tamper");
  await appendFile(
    path.resolve(dossierTamper, "docs", "pcb-design-guides", "research", "02-trace-width-current.md"),
    "tamper",
    "utf8"
  );
  await rejects("tampered dossier", () => verifyDeepRuleResourceDirectory(dossierTamper), /byte length drifted|SHA-256 drifted/iu);

  const catalogTamper = await copyFor("catalog-tamper");
  await appendFile(path.resolve(catalogTamper, "docs", "pcb-design-guides", "rule-catalog.json"), " ", "utf8");
  await rejects("tampered catalog", () => verifyDeepRuleResourceDirectory(catalogTamper), /byte length drifted|SHA-256 drifted/iu);

  const shadow = await copyFor("shadow");
  await writeFile(path.resolve(shadow, "shadow-rule-catalog.json"), '{"shadow":true}\n', "utf8");
  await rejects("shadow catalog", () => verifyDeepRuleResourceDirectory(shadow), /missing, unexpected, or shadow files/iu);

  const emptyDirectory = await copyFor("empty-directory");
  await mkdir(path.resolve(emptyDirectory, "unmanifested-empty"));
  await rejects("empty directory", () => verifyDeepRuleResourceDirectory(emptyDirectory), /shadow files or directories/iu);

  const nestedDirectory = await copyFor("nested-directory");
  await mkdir(path.resolve(nestedDirectory, "docs", "pcb-design-guides", "research", "extra", "nested"), { recursive: true });
  await rejects("nested directory", () => verifyDeepRuleResourceDirectory(nestedDirectory), /shadow files or directories/iu);

  const junctionTarget = await copyFor("root-junction-target");
  const rootJunction = path.resolve(temporaryRoot, "root-junction-alias");
  await symlink(junctionTarget, rootJunction, process.platform === "win32" ? "junction" : "dir");
  await rejects("root junction", () => verifyDeepRuleResourceDirectory(rootJunction), /canonical ordinary directory|link, junction, or reparse/iu);
  await unlink(rootJunction);

  const descendantJunction = await copyFor("descendant-junction");
  const descendantTarget = path.resolve(temporaryRoot, "descendant-junction-target");
  await mkdir(descendantTarget);
  const descendantAlias = path.resolve(descendantJunction, "unmanifested-junction");
  await symlink(descendantTarget, descendantAlias, process.platform === "win32" ? "junction" : "dir");
  await rejects("descendant junction", () => verifyDeepRuleResourceDirectory(descendantJunction), /links, junctions, or reparse/iu);
  await unlink(descendantAlias);

  const manifestTamper = await copyFor("manifest-tamper");
  const manifestPath = path.resolve(manifestTamper, "resource-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.resourceIdentity = `sha256:${"0".repeat(64)}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rejects("rewritten manifest", () => verifyDeepRuleResourceDirectory(manifestTamper), /manifest SHA-256 drifted|manifest identity does not match/iu);

  console.log(`Deep-rule resource verifier adversarial cases passed: ${passed}/10.`);
} finally {
  const temporaryParent = path.resolve(tmpdir());
  if (path.dirname(temporaryRoot) !== temporaryParent || !path.basename(temporaryRoot).startsWith("evleda-deep-rule-verifier-")) {
    throw new Error(`Refusing to remove unexpected temporary directory: ${temporaryRoot}`);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

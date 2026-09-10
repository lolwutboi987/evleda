import { execFile as execFileCallback } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  PACKAGED_DEEP_RULE_RESOURCE_IDENTITY,
  PACKAGED_DEEP_RULE_CATALOG_SHA256,
  createDeepRuleResourceProfile,
  loadDeepRuleResource,
  resolvePackagedDeepRuleResourceDirectory
} from "../../src/harness/deep-rule-catalog.js";

const sourceResource = resolvePackagedDeepRuleResourceDirectory();
const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "..", "..");
const probePath = resolve(repositoryRoot, "tests", "helpers", "probe-packaged-deep-rule-resource.ts");
const tsxPath = resolve(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const execFile = promisify(execFileCallback);
const owned = new Set<string>();

const temporaryResource = async (): Promise<{ readonly root: string; readonly resource: string }> => {
  const root = await mkdtemp(resolve(tmpdir(), "evleda-deep-rule-resource-"));
  const resource = resolve(root, "relocated", "resources", "deep-pcb-rule-corpus", "v1");
  await mkdir(dirname(resource), { recursive: true });
  await cp(sourceResource, resource, { recursive: true });
  owned.add(root);
  return { root, resource };
};

const profileFor = (resource: string) =>
  createDeepRuleResourceProfile(resource, PACKAGED_DEEP_RULE_RESOURCE_IDENTITY);

afterEach(async () => {
  for (const directory of [...owned]) {
    const parent = resolve(tmpdir());
    const back = relative(parent, directory);
    if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
      throw new Error(`Refusing unsafe test cleanup: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
    owned.delete(directory);
  }
});

describe("deep PCB rule packaged resource", () => {
  it("resolves source and relocated dist resources from the module location, not cwd", () => {
    const sourceModule = pathToFileURL(resolve("C:/portable/evleda/src/harness/deep-rule-catalog.ts"));
    const distModule = pathToFileURL(resolve("C:/portable/evleda/dist/src/harness/deep-rule-catalog.js"));
    expect(resolvePackagedDeepRuleResourceDirectory(sourceModule)).toBe(
      resolve("C:/portable/evleda/resources/deep-pcb-rule-corpus/v1")
    );
    expect(resolvePackagedDeepRuleResourceDirectory(distModule)).toBe(
      resolve("C:/portable/evleda/dist/resources/deep-pcb-rule-corpus/v1")
    );
  });

  it("loads from a clean cwd and ignores an ambient shadow catalog", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "evleda-deep-rule-clean-cwd-"));
    owned.add(root);
    const cleanCwd = resolve(root, "clean");
    const shadowDirectory = resolve(cleanCwd, "docs", "pcb-design-guides");
    await mkdir(shadowDirectory, { recursive: true });
    await writeFile(
      resolve(shadowDirectory, "rule-catalog.json"),
      '{"schemaVersion":1,"sourceDossiers":[],"rules":[],"shadow":true}\n',
      "utf8"
    );
    const { stdout } = await execFile(process.execPath, [tsxPath, probePath], { cwd: cleanCwd, windowsHide: true });
    const result = JSON.parse(stdout) as {
      readonly resourceDirectory: string;
      readonly resourceIdentity: string;
      readonly catalogSha256: string;
      readonly ruleCount: number;
      readonly dossierCount: number;
    };
    expect(result).toEqual({
      resourceDirectory: sourceResource,
      resourceIdentity: PACKAGED_DEEP_RULE_RESOURCE_IDENTITY,
      catalogSha256: PACKAGED_DEEP_RULE_CATALOG_SHA256,
      ruleCount: 1_773,
      dossierCount: 17
    });
  });

  it("loads a relocated resource only through an absolute identity-bound profile", async () => {
    const { resource } = await temporaryResource();
    expect(() => createDeepRuleResourceProfile("relative/resources")).toThrow(/absolute profile-bound path/iu);
    const verified = loadDeepRuleResource(profileFor(resource));
    expect(verified.resourceIdentity).toBe(PACKAGED_DEEP_RULE_RESOURCE_IDENTITY);
    expect(verified.catalog.rules).toHaveLength(1_773);
    expect(verified.catalog.sourceDossiers).toHaveLength(17);
    expect(verified.catalogPath.startsWith(resource)).toBe(true);
  });

  it("fails closed when a required dossier is missing", async () => {
    const { resource } = await temporaryResource();
    await unlink(resolve(resource, "docs", "pcb-design-guides", "research", "07-differential-pairs.md"));
    expect(() => loadDeepRuleResource(profileFor(resource))).toThrow(/missing, unexpected, or shadow files/iu);
  });

  it("rejects unmanifested empty and nested directories", async () => {
    const first = await temporaryResource();
    await mkdir(resolve(first.resource, "empty-shadow"));
    expect(() => loadDeepRuleResource(profileFor(first.resource))).toThrow(/shadow files or directories/iu);

    const second = await temporaryResource();
    await mkdir(resolve(second.resource, "docs", "pcb-design-guides", "research", "extra", "nested"), { recursive: true });
    expect(() => loadDeepRuleResource(profileFor(second.resource))).toThrow(/shadow files or directories/iu);
  });

  it("rejects a root junction and a descendant junction", async () => {
    const rootCase = await temporaryResource();
    const rootJunction = resolve(rootCase.root, "resource-root-junction");
    await symlink(rootCase.resource, rootJunction, process.platform === "win32" ? "junction" : "dir");
    expect(() => loadDeepRuleResource(profileFor(rootJunction))).toThrow(/canonical ordinary directory|link, junction, or reparse/iu);
    await unlink(rootJunction);

    const descendantCase = await temporaryResource();
    const outside = resolve(descendantCase.root, "junction-target");
    const descendantJunction = resolve(descendantCase.resource, "descendant-junction");
    await mkdir(outside);
    await symlink(outside, descendantJunction, process.platform === "win32" ? "junction" : "dir");
    expect(() => loadDeepRuleResource(profileFor(descendantCase.resource))).toThrow(/links, junctions, or reparse/iu);
    await unlink(descendantJunction);
  });

  it("fails closed when a dossier or catalog is tampered", async () => {
    const first = await temporaryResource();
    await appendFile(
      resolve(first.resource, "docs", "pcb-design-guides", "research", "02-trace-width-current.md"),
      "tamper",
      "utf8"
    );
    expect(() => loadDeepRuleResource(profileFor(first.resource))).toThrow(/byte length drifted|SHA-256 drifted/iu);

    const second = await temporaryResource();
    await appendFile(resolve(second.resource, "docs", "pcb-design-guides", "rule-catalog.json"), " ", "utf8");
    expect(() => loadDeepRuleResource(profileFor(second.resource))).toThrow(/byte length drifted|SHA-256 drifted/iu);
  });

  it("rejects a rewritten manifest and an in-tree shadow catalog", async () => {
    const first = await temporaryResource();
    const manifestPath = resolve(first.resource, "resource-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { resourceIdentity: string };
    manifest.resourceIdentity = `sha256:${"0".repeat(64)}`;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    expect(() => loadDeepRuleResource(profileFor(first.resource))).toThrow(/manifest SHA-256 drifted|manifest identity does not match|resource identity mismatch/iu);

    const second = await temporaryResource();
    await writeFile(
      resolve(second.resource, "docs", "pcb-design-guides", "shadow-rule-catalog.json"),
      '{"shadow":true}\n',
      "utf8"
    );
    expect(() => loadDeepRuleResource(profileFor(second.resource))).toThrow(/missing, unexpected, or shadow files/iu);
  });
});

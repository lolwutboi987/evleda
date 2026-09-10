#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const DEFAULT_CONFIG_PATHS = Object.freeze([
  "tsconfig.json",
  "tsconfig.build.json",
  "ui/tsconfig.json"
]);
const ADDITIONAL_SOURCE_FILES = Object.freeze(["playwright.config.ts"]);
const ADDITIONAL_SOURCE_DIRECTORIES = Object.freeze(["scripts", "ui/e2e"]);
const TYPESCRIPT_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts"]);
const DECLARATION_PATTERN = /\.d\.(?:ts|mts|cts)$/iu;
const OUTPUT_SUFFIXES = Object.freeze({
  ".ts": [".js", ".js.map", ".d.ts", ".d.ts.map"],
  ".tsx": [".js", ".js.map", ".jsx", ".jsx.map", ".d.ts", ".d.ts.map"],
  ".mts": [".mjs", ".mjs.map", ".d.mts", ".d.mts.map"],
  ".cts": [".cjs", ".cjs.map", ".d.cts", ".d.cts.map"]
});
const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const caseKey = (value) => ts.sys.useCaseSensitiveFileNames ? value : value.toLowerCase();
const toPortablePath = (value) => value.split(path.sep).join("/");

const configHost = Object.freeze({
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory
});

const insideRoot = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const relativeToRoot = (root, target) => toPortablePath(path.relative(root, target));

const diagnosticMessage = (diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

const readConfiguredFiles = (root, relativeConfigPath) => {
  const configPath = path.resolve(root, relativeConfigPath);
  if (!insideRoot(root, configPath)) {
    throw new Error(`Configuration path is outside the repository: ${relativeConfigPath}`);
  }
  const loaded = ts.readConfigFile(configPath, configHost.readFile);
  if (loaded.error !== undefined) {
    throw new Error(`${toPortablePath(relativeConfigPath)}: ${diagnosticMessage(loaded.error)}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    configHost,
    path.dirname(configPath),
    undefined,
    configPath
  );
  if (parsed.errors.length > 0) {
    const messages = parsed.errors.map(diagnosticMessage).sort(compareCodeUnits);
    throw new Error(`${toPortablePath(relativeConfigPath)}: ${messages.join(" | ")}`);
  }
  return parsed.fileNames;
};

const isTypeScriptSource = (file) => {
  const lower = file.toLowerCase();
  return !DECLARATION_PATTERN.test(lower) && TYPESCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

const sourceExtension = (file) => {
  const lower = file.toLowerCase();
  const extension = TYPESCRIPT_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  if (extension === undefined) throw new Error(`Unsupported TypeScript source extension: ${file}`);
  return extension;
};

const addSource = (root, sources, file) => {
  const absolute = path.resolve(file);
  if (!insideRoot(root, absolute)) {
    throw new Error(`Configured source is outside the repository: ${toPortablePath(absolute)}`);
  }
  if (isTypeScriptSource(absolute)) sources.set(caseKey(absolute), absolute);
};

const collectSourceFiles = (root, configPaths) => {
  const sources = new Map();
  for (const configPath of configPaths) {
    for (const file of readConfiguredFiles(root, configPath)) addSource(root, sources, file);
  }
  for (const relativeFile of ADDITIONAL_SOURCE_FILES) {
    const absolute = path.resolve(root, relativeFile);
    if (configHost.fileExists(absolute)) addSource(root, sources, absolute);
  }
  for (const relativeDirectory of ADDITIONAL_SOURCE_DIRECTORIES) {
    const absolute = path.resolve(root, relativeDirectory);
    for (const file of configHost.readDirectory(absolute, TYPESCRIPT_EXTENSIONS, undefined, ["**/*"])) {
      addSource(root, sources, file);
    }
  }
  return [...sources.values()].sort(compareCodeUnits);
};

const adjacentOutputCandidates = (source) => {
  const extension = sourceExtension(source);
  const stem = source.slice(0, -extension.length);
  return OUTPUT_SUFFIXES[extension].map((suffix) => stem + suffix);
};

const pathExistsAsAnyObject = async (candidate) => {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

export const inspectSourceAdjacentEmits = async ({
  root,
  configPaths = DEFAULT_CONFIG_PATHS
}) => {
  const resolvedRoot = path.resolve(root);
  const sources = collectSourceFiles(resolvedRoot, configPaths);
  const candidates = new Map();
  for (const source of sources) {
    for (const candidate of adjacentOutputCandidates(source)) {
      if (!insideRoot(resolvedRoot, candidate)) {
        throw new Error(`Adjacent output candidate is outside the repository: ${toPortablePath(candidate)}`);
      }
      candidates.set(caseKey(candidate), candidate);
    }
  }
  const violations = [];
  for (const candidate of [...candidates.values()].sort(compareCodeUnits)) {
    try {
      if (await pathExistsAsAnyObject(candidate)) violations.push(relativeToRoot(resolvedRoot, candidate));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot inspect ${relativeToRoot(resolvedRoot, candidate)}: ${message}`);
    }
  }
  violations.sort(compareCodeUnits);
  return Object.freeze({ sourceCount: sources.length, violations: Object.freeze(violations) });
};

const parseCli = (argumentsValue) => {
  let root;
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    if (argument === "--root") {
      const value = argumentsValue[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--root requires a path");
      root = value;
      index += 1;
    } else if (argument.startsWith("--root=")) {
      root = argument.slice("--root=".length);
      if (root.length === 0) throw new Error("--root requires a path");
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { root };
};

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  const invoked = path.resolve(process.argv[1]);
  const current = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? invoked.toLocaleLowerCase("en-US") === current.toLocaleLowerCase("en-US")
    : invoked === current;
})();

if (isMain) {
  try {
    const cli = parseCli(process.argv.slice(2));
    const result = await inspectSourceAdjacentEmits({ root: cli.root ?? defaultRoot });
    if (result.violations.length > 0) {
      console.error([
        "Source-adjacent compiler outputs are forbidden because Vitest/Vite loads exact JavaScript before TypeScript.",
        `Found ${String(result.violations.length)} forbidden path(s):`,
        ...result.violations.map((file) => `  ${file}`),
        "Remove these files and use --noEmit for checks or tsconfig.build.json for dist output."
      ].join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`Source-adjacent emit guard passed for ${String(result.sourceCount)} configured TypeScript source(s).`);
    }
  } catch (error) {
    console.error(`Source-adjacent emit guard failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

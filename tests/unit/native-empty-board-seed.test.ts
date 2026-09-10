import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import {
  createNativeEmptyBoardSeed,
  NATIVE_EMPTY_BOARD_CRLF_IDENTITY,
  NATIVE_EMPTY_BOARD_LF_IDENTITY,
} from "../../src/harness/native-empty-board-seed.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createGenericDividerBundleFixture, genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";

// Independent capture and literal pins; expected bytes never come from the producer.
const capturedLf = await readFile(new URL("../fixtures/fresh-project/native-empty-board.kicad_pcb", import.meta.url));
const lfPin = { algorithm: "sha256", digest: "8be439fee8716117c4da47e1e947c749ff4889df564d25a51f2640dec48f4a09", size: 1733 };
// Derived representation only, not an additional native Save observation.
const crlfPin = { algorithm: "sha256", digest: "5f482a9458a6c5710ec5df740495991198d31009be38bce9c823abf0e83b4a85", size: 1814 };
const expectedCrlf = Buffer.from(capturedLf.toString("utf8").replaceAll("\n", "\r\n"));
const rawIdentity = (bytes: Buffer) => ({ algorithm: "sha256", digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
const roots = new Set<string>();
afterEach(async () => {
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Unsafe seed-test cleanup target");
    await rm(resolved, { recursive: true, force: true });
  }
  roots.clear();
});

const workflows = ["led_compatibility_fixture", "generic", "plane"] as const;
async function preparationOptions(workflowKind: typeof workflows[number]) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "evleda-native-blank-"));
  roots.add(outputDir);
  const base = { outputDir, name: "native-blank", resume: false };
  if (workflowKind === "led_compatibility_fixture") return { ...base, workflowKind };
  if (workflowKind === "generic") {
    const { bundle, reference } = createGenericDividerBundleFixture();
    return { ...base, workflowKind, compilationBundle: bundle, compilationBundleRef: reference };
  }
  const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  const bundle = createPcbPlaneCompilationBundle({ originalPrompt: "Native blank seed regression fixture.", compilation }, dependencies);
  return { ...base, workflowKind, compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) };
}

describe("pinned native empty-board seed", () => {
  it("retains the original LF capture and immutable fixed identities", () => {
    expect(rawIdentity(capturedLf)).toEqual(lfPin);
    expect(capturedLf.includes(13)).toBe(false);
    expect(capturedLf.toString("utf8").split("\n")).toHaveLength(82);
    expect(rawIdentity(expectedCrlf)).toEqual(crlfPin);
    expect(NATIVE_EMPTY_BOARD_LF_IDENTITY).toEqual(lfPin);
    expect(NATIVE_EMPTY_BOARD_CRLF_IDENTITY).toEqual(crlfPin);
    expect(Object.isFrozen(NATIVE_EMPTY_BOARD_LF_IDENTITY)).toBe(true);
    expect(Object.isFrozen(NATIVE_EMPTY_BOARD_CRLF_IDENTITY)).toBe(true);
  });

  it.each(["win32", "linux", "darwin", "aix", "freebsd", "openbsd", "sunos", "android", "haiku", "cygwin", "netbsd"] as const)(
    "generates exact deterministic %s bytes from the independent capture", (platform) => {
      const source = createNativeEmptyBoardSeed(platform);
      const actual = Buffer.from(source);
      expect(actual).toEqual(platform === "win32" ? expectedCrlf : capturedLf);
      expect(rawIdentity(actual)).toEqual(platform === "win32" ? crlfPin : lfPin);
      expect(createNativeEmptyBoardSeed(platform)).toBe(source);
    },
  );

  it("defaults to the host platform and has native defaults without design content", () => {
    const source = createNativeEmptyBoardSeed();
    expect(Buffer.from(source)).toEqual(process.platform === "win32" ? expectedCrlf : capturedLf);
    expect(source).toContain('(generator "pcbnew")');
    expect(source).toContain('(generator_version "10.0")');
    expect(source).toContain("(thickness 1.6)");
    expect(source).toContain("(setup");
    expect([...source.matchAll(/^\t\t\(\d+ "[^"]+" (?:signal|user)(?: "[^"]+")?\)\r?$/gmu)]).toHaveLength(14);
    expect(source).not.toMatch(/\((?:uuid|tstamp|net|footprint|segment|via|zone|gr_[a-z_]+|title_block|path)\b/u);
    expect(parseFreshPcbSource(source)).toMatchObject({
      version: 20260206, footprints: [], segments: [], vias: [], viaCount: 0, zoneNetNames: [], outlineBounds: null,
    });
  });

  it.each(workflows)("prepares %s disk bytes before binding the marker hash", async (workflowKind) => {
    const project = await prepareFreshProject(await preparationOptions(workflowKind));
    const actual = await readFile(project.pcbPath);
    const expected = process.platform === "win32" ? expectedCrlf : capturedLf;
    expect(actual).toEqual(expected);
    expect(rawIdentity(actual)).toEqual(process.platform === "win32" ? crlfPin : lfPin);
    const marker = JSON.parse(await readFile(project.markerPath, "utf8"));
    expect(marker.files.pcb).toEqual({ path: project.pcbPath, sha256: rawIdentity(expected).digest });
    expect(actual.toString("utf8")).not.toContain(project.name);
    expect(actual.toString("utf8")).not.toContain(project.projectPath);
  });

  it.each(workflows)("resumes historical %s marker/checkpoint bytes without replacing the board", async (workflowKind) => {
    const options = await preparationOptions(workflowKind);
    const project = await prepareFreshProject(options);
    // Synthetic prior emitter, deliberately retaining its original LF representation.
    const historical = Buffer.from('(kicad_pcb\n  (version 20260206)\n  (generator "KiCad Studio Fixture Corpus")\n  (general)\n  (paper "A4")\n  (layers\n    (0 "F.Cu" signal)\n    (2 "B.Cu" signal)\n    (1 "F.Mask" user)\n    (3 "B.Mask" user)\n    (5 "F.SilkS" user)\n    (7 "B.SilkS" user)\n    (13 "F.Paste" user)\n    (15 "B.Paste" user)\n    (25 "Edge.Cuts" user)\n    (33 "B.Fab" user)\n    (35 "F.Fab" user)\n  )\n)\n');
    expect(historical).not.toEqual(await readFile(project.pcbPath));
    await writeFile(project.pcbPath, historical);
    const marker = JSON.parse(await readFile(project.markerPath, "utf8"));
    marker.files.pcb.sha256 = rawIdentity(historical).digest;
    const markerBytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`);
    await writeFile(project.markerPath, markerBytes);
    const resumed = await prepareFreshProject({ ...options, resume: true });
    const report = path.join(options.outputDir, "pcb-agent-report.json");
    await writeFile(report, '{"status":"needs_review"}');
    await resumed.checkpointAfterReport(report, "needs_review");
    const checkpoint = await readFile(resumed.checkpointPath);
    await prepareFreshProject({ ...options, resume: true });
    expect(await readFile(project.pcbPath)).toEqual(historical);
    expect(await readFile(project.markerPath)).toEqual(markerBytes);
    expect(await readFile(project.checkpointPath)).toEqual(checkpoint);
  });
});

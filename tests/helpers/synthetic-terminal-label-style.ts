import path from "node:path";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createFreshSchematicStrokeStyleEvidence, FRESH_SCHEMATIC_STROKE_NATIVE_PROFILE as profile } from "../../src/harness/fresh-schematic-stroke-style.js";

/** Synthetic software fixture only; no native renderer or hardware execution. */
export function syntheticTerminalLabelStyle(source: string) {
  const schematic = contentIdentity(source), projectSettingsSource = "{}", applicationSource = "{}";
  const executablePath = path.resolve("D:/pinned-terminal-label/kicad-cli.exe"), cwd = path.resolve("D:/terminal-label/project"), output = path.resolve("D:/terminal-label/render");
  const executable = { kind: "kicad-cli" as const, path: executablePath, version: profile.version, commit: "a".repeat(40), sha256: profile.executable.digest,
    sizeBytes: profile.executable.size, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["sch export svg"] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>', nativeSvg = contentIdentity(svg), config = contentIdentity(applicationSource);
  const sources = { schematic, pcb: contentIdentity("synthetic PCB"), projectSettings: contentIdentity(projectSettingsSource) };
  const tree = canonicalIdentity({ schemaVersion: "evleda.kicad-schematic-configuration-tree.v1", files: [{ relativePath: "10.0/eeschema.json", identity: config }], directories: ["10.0"] }, "evleda.kicad-schematic-configuration-tree.v1");
  return createFreshSchematicStrokeStyleEvidence({ projectSettingsSource,
    render: { classification: "candidate-validation", releaseAuthorized: false, executable, outputDirectory: output, sourceHashes: { "test.kicad_sch": schematic.digest }, sourceIdentities: sources,
      invocation: { executable, command: executablePath, args: ["sch", "export", "svg", "--output", output, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", path.join(cwd, "test.kicad_sch")], cwd, exitCode: 0, stdout: "", stderr: "", durationMs: 1, startedAt: "2026-09-17T12:00:00.000Z" },
      schematicSvg: { path: path.join(output, "test.svg"), relativePath: "test.svg", sha256: nativeSvg.digest, sizeBytes: nativeSvg.size }, source: svg },
    schematicEngine: { path: path.join(path.dirname(executablePath), "_eeschema.dll"), before: profile.schematicEngine, after: profile.schematicEngine },
    configuration: { isolation: "caller-owned-isolated", configHome: path.resolve("D:/terminal-label/config"), treeBefore: tree, treeAfter: tree,
      applicationConfig: { relativePath: "10.0/eeschema.json", source: applicationSource, before: config, after: config } },
  }, sources);
}

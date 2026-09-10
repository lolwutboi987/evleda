import path from "node:path";
import { contentIdentity } from "../../src/core/canonical.js";
import type { KicadExecutableIdentity, KicadSchematicSvgResult } from "../../src/integrations/kicad-cli.js";
import type { SchematicRenderClearanceExpected } from "../../src/integrations/schematic-render-clearance.js";

export const CLEAR_SCHEMATIC_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><g fill="none" stroke="#000000" stroke-width="0.2" stroke-linecap="round" stroke-linejoin="round"><text x="1" y="1" opacity="0">R1</text><g class="stroked-text"><desc>R1</desc><path d="M1 1 L2 1"/></g><path d="M8 8 L9 8"/></g></svg>';
export const COLLIDING_SCHEMATIC_SVG = CLEAR_SCHEMATIC_SVG.replace("M8 8 L9 8", "M1.5 0 L1.5 2");

/** Deterministic fake native output; this is test evidence, never a native proof. */
export function schematicRenderCapture(expected: SchematicRenderClearanceExpected, outputDirectory = "C:/private/test-svg", source = CLEAR_SCHEMATIC_SVG): KicadSchematicSvgResult {
  const executable: KicadExecutableIdentity = { kind: "kicad-cli", path: "C:/test/kicad-cli.exe", version: "10.0.3", commit: "abcdef0", sha256: expected.executable.sha256, sizeBytes: expected.executable.sizeBytes, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["sch export svg"] };
  const target = path.join(outputDirectory, "board.svg");
  return { classification: "candidate-validation", releaseAuthorized: false, executable, outputDirectory, source,
    sourceIdentities: expected.sources, sourceHashes: { "board.kicad_sch": expected.sources.schematic.digest, "board.kicad_pcb": expected.sources.pcb.digest, "board.kicad_pro": expected.sources.projectSettings.digest },
    schematicSvg: { path: target, relativePath: "board.svg", sha256: contentIdentity(source).digest, sizeBytes: Buffer.byteLength(source) },
    invocation: { executable, command: executable.path, args: ["sch", "export", "svg", "--output", outputDirectory, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", "C:/private/board.kicad_sch"], cwd: "C:/private", exitCode: 0, stdout: "native export fixture", stderr: "", durationMs: 1, startedAt: "2026-09-09T00:00:00.000Z" } };
}

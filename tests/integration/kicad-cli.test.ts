import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { portableContentIdentity } from "../../src/core/portable-artifact.js";
import { contentIdentity } from "../../src/core/canonical.js";

import {
  ProcessAbortError,
  ProcessOutputLimitError,
  ProcessTreeTerminationUnconfirmedError,
  ProcessTimeoutError,
  runBoundedProcess,
  type BoundedProcessOptions,
  type BoundedProcessResult,
  type BoundedProcessRunner,
} from "../../src/integrations/bounded-process.js";
import {
  configuredKicadCliPath,
  KicadCliAdapter,
  KicadCliInvocationError,
  KicadSourceMutationError,
} from "../../src/integrations/kicad-cli.js";
import {
  buildPortableKicadCommandPlanV1,
  buildPortableKicadNativeProcessPlanV2,
  resolvePortableKicadCommandPlanV2,
} from "../../src/integrations/portable-kicad-runtime.js";

const TEST_KICAD_CLI_PATH = configuredKicadCliPath();
const PACKAGED_REAL_KICAD_FIXTURE_PATH = path.resolve(
  "..",
  "source-materials",
  "kicad-mcp-audit",
  "kicad-mcp-pro",
  "tests",
  "fixtures",
  "benchmark_projects",
  "pass_minimal_mcu_board",
);
const LEGACY_REAL_KICAD_FIXTURE_PATH =
  "C:\\Users\\kidch\\AppData\\Local\\Temp\\evleda-kicad-mcp-audit\\kicad-mcp-pro\\tests\\fixtures\\benchmark_projects\\pass_minimal_mcu_board";
const REAL_KICAD_FIXTURE_PATH = existsSync(PACKAGED_REAL_KICAD_FIXTURE_PATH)
  ? PACKAGED_REAL_KICAD_FIXTURE_PATH
  : LEGACY_REAL_KICAD_FIXTURE_PATH;

const ALL_HELP_TOKENS = [
  "--format",
  "json",
  "--exit-code-violations",
  "--severity-all",
  "--units",
  "--schematic-parity",
  "--refill-zones",
  "--save-board",
  "--output",
  "--fields",
  "--labels",
  "--group-by",
  "--sort-field",
  "kicadsexpr",
  "--black-and-white",
  "--no-background-color",
  "--layers",
  "--precision",
  "--no-protel-ext",
  "--drill-origin",
  "--excellon-units",
  "--generate-report",
  "--side",
  "--exclude-dnp",
  "--width",
  "--height",
  "--quality",
  "--preset",
].join(" ");

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  workspace: string;
  project: string;
  schematic: string;
  pcb: string;
}> {
  const workspace = await mkdtemp(path.join(tmpdir(), "evleda-cli-test-"));
  temporaryRoots.push(workspace);
  const project = path.join(workspace, "working-copy");
  await mkdir(project);
  const schematic = path.join(project, "robot.kicad_sch");
  const pcb = path.join(project, "robot.kicad_pcb");
  await Promise.all([
    writeFile(path.join(project, "robot.kicad_pro"), "{}\n", "utf8"),
    writeFile(schematic, "(kicad_sch (version 20250114))\n", "utf8"),
    writeFile(
      pcb,
      `(kicad_pcb (version 20250114)\n  (layers\n    (0 "F.Cu" signal)\n    (2 "In1.Cu" power)\n    (31 "B.Cu" signal)\n    (32 "B.Adhes" user "b.adhesive")\n    (33 "F.Adhes" user "f.adhesive")\n    (34 "B.Paste" user)\n    (35 "F.Paste" user)\n    (36 "B.SilkS" user "b.silkscreen")\n    (37 "F.SilkS" user "f.silkscreen")\n    (38 "B.Mask" user)\n    (39 "F.Mask" user)\n    (44 "Edge.Cuts" user)\n  )\n)\n`,
      "utf8",
    ),
  ]);
  return { workspace, project, schematic, pcb };
}

function result(options: BoundedProcessOptions, values: Partial<BoundedProcessResult> = {}): BoundedProcessResult {
  return {
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    startedAt: "2026-09-03T00:00:00.000Z",
    ...values,
  };
}

function outputPath(args: readonly string[]): string {
  const index = args.indexOf("--output");
  const output = args[index + 1];
  if (index < 0 || output === undefined) throw new Error("missing --output in fake");
  return output;
}

function probeResult(options: BoundedProcessOptions): BoundedProcessResult | undefined {
  if (options.args.length === 1 && options.args[0] === "version") {
    return result(options, { stdout: "10.0.3\n" });
  }
  if (options.args.join(" ") === "version --format commit") {
    return result(options, { stdout: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622\n" });
  }
  if (options.args.at(-1) === "--help") {
    return result(options, { stdout: ALL_HELP_TOKENS });
  }
  return undefined;
}

async function writeFakeExport(args: readonly string[]): Promise<void> {
  const signature = args.slice(0, 3).join(" ");
  const output = outputPath(args);
  if (signature === "sch export svg") {
    await writeFile(path.join(output, "robot.svg"), "<svg/>\n", "utf8");
  } else if (signature === "pcb export gerbers") {
    await writeFile(path.join(output, "robot-F_Cu.gbr"), "G04 fake*\n", "utf8");
  } else if (signature === "pcb export drill") {
    await Promise.all([
      writeFile(path.join(output, "robot-PTH.drl"), "M48\n", "utf8"),
      writeFile(args[args.indexOf("--report-path") + 1]!, "drill report\n", "utf8"),
    ]);
  } else {
    await writeFile(output, `${signature}\n`, "utf8");
  }
}

describe("bounded subprocess runner", () => {
  it("uses argv without shell interpretation", async () => {
    const hostile = "& echo should-not-run";
    const invocation = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", hostile],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 2_000,
      maxOutputBytes: 1024,
    });
    expect(invocation).toMatchObject({ exitCode: 0, stdout: hostile, stderr: "" });
  });

  it("kills output floods and timeouts", async () => {
    const floodError = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2048))"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 2_000,
      maxOutputBytes: 64,
    }).catch((error: unknown) => error);
    if (floodError instanceof ProcessTreeTerminationUnconfirmedError) {
      expect(floodError).toMatchObject({
        retainWorkingDirectory: true,
        primaryErrorName: "ProcessOutputLimitError",
        confirmationFailure: "tree_death_unconfirmed",
        stdout: "x".repeat(64),
      });
      expect(floodError.cause).toBeInstanceOf(ProcessOutputLimitError);
      expect((floodError.cause as ProcessOutputLimitError).stdout).toBe("x".repeat(64));
    } else {
      expect(floodError).toBeInstanceOf(ProcessOutputLimitError);
    }
    const timeoutError = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 30,
      maxOutputBytes: 64,
    }).catch((error: unknown) => error);
    if (timeoutError instanceof ProcessTreeTerminationUnconfirmedError) {
      expect(timeoutError).toMatchObject({
        primaryErrorName: "ProcessTimeoutError",
        confirmationFailure: "tree_death_unconfirmed",
      });
      expect(timeoutError.cause).toBeInstanceOf(ProcessTimeoutError);
    } else {
      expect(timeoutError).toBeInstanceOf(ProcessTimeoutError);
    }

    const controller = new AbortController();
    const aborted = runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 2_000,
      maxOutputBytes: 64,
      signal: controller.signal,
    });
    controller.abort();
    const abortError = await aborted.catch((error: unknown) => error);
    if (abortError instanceof ProcessTreeTerminationUnconfirmedError) {
      expect(abortError).toMatchObject({
        primaryErrorName: "ProcessAbortError",
        confirmationFailure: "tree_death_unconfirmed",
      });
      expect(abortError.cause).toBeInstanceOf(ProcessAbortError);
    } else {
      expect(abortError).toBeInstanceOf(ProcessAbortError);
    }
  });
});

describe("KiCad 10 CLI adapter", () => {
  it("uses an explicit path, then EVLEDA_KICAD_CLI, before the Windows default", () => {
    expect(
      configuredKicadCliPath("C:\\tools\\explicit\\kicad-cli.exe", {
        EVLEDA_KICAD_CLI: "C:\\tools\\environment\\kicad-cli.exe",
      }),
    ).toBe("C:\\tools\\explicit\\kicad-cli.exe");
    expect(
      configuredKicadCliPath(undefined, {
        EVLEDA_KICAD_CLI: "C:\\tools\\environment\\kicad-cli.exe",
      }),
    ).toBe("C:\\tools\\environment\\kicad-cli.exe");
  });

  it("rejects source changes during discovery probes and between operations", async () => {
    const duringProbe = await fixture();
    let mutated = false;
    const mutatingProbeRunner: BoundedProcessRunner = async (options) => {
      const probe = probeResult(options);
      if (probe === undefined) throw new Error("operational process should not run");
      if (!mutated) {
        mutated = true;
        await appendFile(duringProbe.pcb, "; changed during discovery\n", "utf8");
      }
      return probe;
    };
    await expect(
      KicadCliAdapter.create({
        workspaceRoot: duringProbe.workspace,
        projectRoot: duringProbe.project,
        executablePath: process.execPath,
        runner: mutatingProbeRunner,
      }),
    ).rejects.toBeInstanceOf(KicadSourceMutationError);

    const betweenOperations = await fixture();
    const runner: BoundedProcessRunner = async (options) => {
      const probe = probeResult(options);
      if (probe !== undefined) return probe;
      throw new Error("operational process should not run after a stale-source change");
    };
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: betweenOperations.workspace,
      projectRoot: betweenOperations.project,
      executablePath: process.execPath,
      runner,
    });
    await appendFile(betweenOperations.schematic, "; changed after discovery\n", "utf8");
    await expect(
      adapter.runChecks({
        schematicPath: betweenOperations.schematic,
        pcbPath: betweenOperations.pcb,
        outputDirectory: path.join(betweenOperations.workspace, "stale-check"),
      }),
    ).rejects.toBeInstanceOf(KicadSourceMutationError);
  });

  it("runs ERC/DRC JSON with violation exits and schematic parity", async () => {
    const design = await fixture();
    const invocations: BoundedProcessOptions[] = [];
    const runner: BoundedProcessRunner = async (options) => {
      invocations.push(options);
      const probe = probeResult(options);
      if (probe !== undefined) return probe;
      const reportPath = outputPath(options.args);
      if (options.args[0] === "sch" && options.args[1] === "erc") {
        await writeFile(
          reportPath,
          JSON.stringify({
            $schema: "https://schemas.kicad.org/erc.v1.json",
            coordinate_units: "mm",
            kicad_version: "10.0.3",
            source: "robot.kicad_sch",
            sheets: [{ path: "/", violations: [{ severity: "warning" }] }],
          }),
          "utf8",
        );
        return result(options, { exitCode: 5, stdout: "Found 1 violation" });
      }
      await writeFile(
        reportPath,
        JSON.stringify({
          $schema: "https://schemas.kicad.org/drc.v1.json",
          coordinate_units: "mm",
          kicad_version: "10.0.3",
          source: "robot.kicad_pcb",
          violations: [],
          unconnected_items: [],
          schematic_parity: [{ severity: "warning", type: "extra_footprint" }],
        }),
        "utf8",
      );
      return result(options, { exitCode: 5, stdout: "Found 1 schematic parity issue" });
    };
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: design.workspace,
      projectRoot: design.project,
      environment: { ...process.env, EVLEDA_KICAD_CLI: process.execPath },
      runner,
    });
    const output = path.join(design.workspace, "checks");
    const checked = await adapter.runChecks({
      schematicPath: design.schematic,
      pcbPath: design.pcb,
      outputDirectory: output,
    });

    expect(checked).toMatchObject({
      classification: "candidate-validation",
      releaseAuthorized: false,
      clean: false,
      erc: { status: "violations", violationCount: 1 },
      drc: { status: "violations", violationCount: 1, schematicParityCount: 1 },
      executable: { version: "10.0.3" },
    });
    const operational = invocations.filter((call) => call.args.at(-1) !== "--help").slice(2);
    expect(operational[0]?.args).toEqual(
      expect.arrayContaining(["--format", "json", "--exit-code-violations", "--severity-all"]),
    );
    expect(operational[1]?.args).toEqual(
      expect.arrayContaining([
        "--format",
        "json",
        "--exit-code-violations",
        "--schematic-parity",
      ]),
    );
    expect(checked.sourceHashes).toHaveProperty("robot.kicad_pro");
    expect(checked.sourceHashes).toHaveProperty("robot.kicad_sch");
    expect(checked.sourceHashes).toHaveProperty("robot.kicad_pcb");

    const firstIdentity = adapter.identity;
    const secondIdentity = adapter.identity;
    expect(firstIdentity).not.toBe(secondIdentity);
    expect(firstIdentity.confirmedCapabilities).not.toBe(secondIdentity.confirmedCapabilities);
    expect(Object.isFrozen(firstIdentity)).toBe(true);
    expect(Object.isFrozen(firstIdentity.confirmedCapabilities)).toBe(true);
    expect(Object.isFrozen(checked)).toBe(true);
    expect(Object.isFrozen(checked.erc)).toBe(true);
    expect(Object.isFrozen(checked.drc)).toBe(true);
    expect(Object.isFrozen(checked.erc.invocation)).toBe(true);
    expect(Object.isFrozen(checked.erc.invocation.args)).toBe(true);
    expect(Object.isFrozen(checked.erc.invocation.executable)).toBe(true);
    expect(Object.isFrozen(checked.erc.report)).toBe(true);
    expect(checked.executable).not.toBe(checked.erc.invocation.executable);
    expect(checked.erc.invocation.executable).not.toBe(checked.drc.invocation.executable);

    const expectedExecutableDigest = firstIdentity.sha256;
    expect(() => {
      (firstIdentity as { sha256: string }).sha256 = "0".repeat(64);
    }).toThrow(TypeError);
    expect(() => {
      (checked.erc.invocation.executable as { sizeBytes: number }).sizeBytes = 0;
    }).toThrow(TypeError);
    expect(() => {
      (checked.erc as { status: string }).status = "clean";
    }).toThrow(TypeError);
    expect(() => {
      (checked.drc as { violationCount: number }).violationCount = 0;
    }).toThrow(TypeError);
    expect(() => {
      (checked.erc.invocation.args as string[]).push("--hostile");
    }).toThrow(TypeError);
    expect(() => {
      (firstIdentity.confirmedCapabilities as string[]).push("attacker capability");
    }).toThrow(TypeError);
    expect(() => {
      (checked.erc.report as { source: string }).source = "attacker.kicad_sch";
    }).toThrow(TypeError);

    const checkedAgain = await adapter.runChecks({
      schematicPath: design.schematic,
      pcbPath: design.pcb,
      outputDirectory: path.join(design.workspace, "checks-again"),
    });
    expect(adapter.identity.sha256).toBe(expectedExecutableDigest);
    expect(checkedAgain.executable.sha256).toBe(expectedExecutableDigest);
    expect(checkedAgain.executable).not.toBe(checked.executable);
    expect(checkedAgain.erc).not.toBe(checked.erc);
    expect(checkedAgain.drc).not.toBe(checked.drc);
    expect(checkedAgain.erc.report).not.toBe(checked.erc.report);
    expect(checkedAgain.erc.invocation).not.toBe(checked.erc.invocation);
    expect(checkedAgain.erc.invocation.executable).not.toBe(
      checked.erc.invocation.executable,
    );
  });

  it("exports one source-preserving schematic netlist for post-save parity", async () => {
    const design = await fixture();
    const operational: BoundedProcessOptions[] = [];
    const source = '(export (components (comp (ref "J1"))) (nets (net (code "1") (name "VCC") (node (ref "J1") (pin "1")))))\n';
    const runner: BoundedProcessRunner = async (options) => {
      const probe = probeResult(options);
      if (probe !== undefined) return probe;
      operational.push(options);
      await writeFile(outputPath(options.args), source, "utf8");
      return result(options);
    };
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: design.workspace,
      projectRoot: design.project,
      executablePath: process.execPath,
      runner,
    });
    const capture = await adapter.exportSchematicNetlist({
      schematicPath: design.schematic,
      pcbPath: design.pcb,
      outputDirectory: path.join(design.workspace, "native-netlist"),
    });
    expect(operational).toHaveLength(1);
    expect(operational[0]?.args).toEqual(["sch", "export", "netlist", "--output", capture.schematicNetlist.path, "--format", "kicadsexpr", design.schematic]);
    expect(capture).toMatchObject({ classification: "candidate-validation", releaseAuthorized: false, source });
    expect(capture.schematicNetlist.relativePath).toBe("schematic-netlist.kicad_net");
    expect(capture.sourceHashes).toHaveProperty("robot.kicad_sch");
  });

  it("exports only one exact-byte source-preserving schematic SVG", async () => {
    const design = await fixture(); const calls: BoundedProcessOptions[] = [];
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><desc>R1 Ω</desc></svg>\r\n';
    const runner: BoundedProcessRunner = async (options) => {
      const probe = probeResult(options); if (probe !== undefined) return probe;
      calls.push(options); await writeFile(path.join(outputPath(options.args), "robot.svg"), source, "utf8"); return result(options);
    };
    const adapter = await KicadCliAdapter.create({ workspaceRoot: design.workspace, projectRoot: design.project, executablePath: process.execPath, runner });
    const exported = await adapter.exportSchematicSvg({ schematicPath: design.schematic, pcbPath: design.pcb, outputDirectory: path.join(design.workspace, "native-svg") });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["sch", "export", "svg", "--output", exported.outputDirectory, "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", design.schematic]);
    expect(exported).toMatchObject({ classification: "candidate-validation", releaseAuthorized: false, source });
    expect(exported.schematicSvg).toMatchObject({ relativePath: "robot.svg", sha256: contentIdentity(source).digest, sizeBytes: Buffer.byteLength(source) });
    expect(exported.sourceIdentities).toEqual({ schematic: contentIdentity(await readFile(design.schematic)), pcb: contentIdentity(await readFile(design.pcb)), projectSettings: contentIdentity(await readFile(path.join(design.project, "robot.kicad_pro"))) });
    expect(exported.invocation.executable).toEqual(exported.executable);
    expect(Object.isFrozen(exported.sourceIdentities)).toBe(true);
    expect(Object.isFrozen(exported.sourceIdentities.schematic)).toBe(true);
  });

  it.each(["before", "during"] as const)("rejects schematic SVG export with source drift %s export", async (when) => {
    const design = await fixture(); let exports = 0;
    const runner: BoundedProcessRunner = async (options) => {
      const probe = probeResult(options); if (probe !== undefined) return probe;
      exports += 1; await writeFile(path.join(outputPath(options.args), "robot.svg"), "<svg/>\n", "utf8");
      if (when === "during") await appendFile(design.schematic, " "); return result(options);
    };
    const adapter = await KicadCliAdapter.create({ workspaceRoot: design.workspace, projectRoot: design.project, executablePath: process.execPath, runner });
    if (when === "before") await appendFile(design.schematic, " ");
    await expect(adapter.exportSchematicSvg({ schematicPath: design.schematic, pcbPath: design.pcb, outputDirectory: path.join(design.workspace, "drift-svg") })).rejects.toBeInstanceOf(KicadSourceMutationError);
    expect(exports).toBe(when === "before" ? 0 : 1);
  });

  it.each(["multiple sheets", "invalid UTF-8"] as const)("rejects unsupported schematic SVG artifact capture: %s", async (failure) => {
    const design = await fixture();
    const runner: BoundedProcessRunner = async (options) => {
      const probe = probeResult(options); if (probe !== undefined) return probe;
      await writeFile(path.join(outputPath(options.args), "robot.svg"), failure === "invalid UTF-8" ? Buffer.from([0xc3, 0x28]) : Buffer.from("<svg/>\n"));
      if (failure === "multiple sheets") await writeFile(path.join(outputPath(options.args), "child.svg"), "<svg/>\n");
      return result(options);
    };
    const adapter = await KicadCliAdapter.create({ workspaceRoot: design.workspace, projectRoot: design.project, executablePath: process.execPath, runner });
    await expect(adapter.exportSchematicSvg({ schematicPath: design.schematic, pcbPath: design.pcb, outputDirectory: path.join(design.workspace, "invalid-svg") })).rejects.toThrow(failure === "multiple sheets" ? /exactly one matching sheet/ : /valid UTF-8/);
  });

  it("rejects a check whose JSON findings disagree with its exit code", async () => {
    const design = await fixture();
    const runner: BoundedProcessRunner = async (options) => {
      const probe = probeResult(options);
      if (probe !== undefined) return probe;
      await writeFile(
        outputPath(options.args),
        JSON.stringify({
          $schema: "https://schemas.kicad.org/erc.v1.json",
          coordinate_units: "mm",
          kicad_version: "10.0.3",
          source: "robot.kicad_sch",
          sheets: [{ path: "/", violations: [{ severity: "warning" }] }],
        }),
        "utf8",
      );
      return result(options, { exitCode: 0 });
    };
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: design.workspace,
      projectRoot: design.project,
      executablePath: process.execPath,
      runner,
    });
    await expect(
      adapter.runChecks({
        schematicPath: design.schematic,
        pcbPath: design.pcb,
        outputDirectory: path.join(design.workspace, "bad-check"),
      }),
    ).rejects.toBeInstanceOf(KicadCliInvocationError);
  });

  it("exports explicit candidate artifacts to a new empty directory", async () => {
    const design = await fixture();
    const invocations: BoundedProcessOptions[] = [];
    const runner: BoundedProcessRunner = async (options) => {
      invocations.push(options);
      const probe = probeResult(options);
      if (probe !== undefined) return probe;
      await writeFakeExport(options.args);
      return result(options);
    };
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: design.workspace,
      projectRoot: design.project,
      executablePath: process.execPath,
      runner,
    });
    const exported = await adapter.exportCandidateArtifacts({
      schematicPath: design.schematic,
      pcbPath: design.pcb,
      outputDirectory: path.join(design.workspace, "candidate-artifacts"),
    });

    expect(exported).toMatchObject({
      classification: "candidate",
      releaseAuthorized: false,
      gerberLayers: [
        "F.Cu",
        "In1.Cu",
        "B.Cu",
        "F.Paste",
        "B.Paste",
        "F.SilkS",
        "B.SilkS",
        "F.Mask",
        "B.Mask",
        "Edge.Cuts",
      ],
    });
    expect(exported.invocations).toHaveLength(8);
    expect(exported.artifacts.map((artifact) => artifact.relativePath)).toEqual(
      expect.arrayContaining([
        "bom.csv",
        "netlist.kicad_net",
        "schematic/robot.svg",
        "gerbers/robot-F_Cu.gbr",
        "drill/robot-PTH.drl",
        "drill/drill-report.rpt",
        "positions.csv",
        "renders/board-top.png",
        "renders/board-bottom.png",
      ]),
    );
    const commands = invocations.map((call) => call.args.join(" "));
    expect(commands).toContainEqual(expect.stringContaining("pcb export gerbers"));
    expect(commands).toContainEqual(expect.stringContaining("--precision 6"));
    expect(commands).toContainEqual(expect.stringContaining("pcb export drill"));
    expect(commands).toContainEqual(expect.stringContaining("pcb export pos"));
    expect(
      commands.filter(
        (command) => command.startsWith("pcb render") && !command.endsWith("--help"),
      ),
    ).toHaveLength(2);
  });

  it("detects any KiCad native source mutation caused by an export process", async () => {
    const design = await fixture();
    const runner: BoundedProcessRunner = async (options) => {
      const probe = probeResult(options);
      if (probe !== undefined) return probe;
      await writeFakeExport(options.args);
      if (options.args.slice(0, 3).join(" ") === "sch export bom") {
        await appendFile(design.pcb, "; mutated\n", "utf8");
      }
      return result(options);
    };
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: design.workspace,
      projectRoot: design.project,
      executablePath: process.execPath,
      runner,
    });
    await expect(
      adapter.exportCandidateArtifacts({
        schematicPath: design.schematic,
        pcbPath: design.pcb,
        outputDirectory: path.join(design.workspace, "mutating-export"),
      }),
    ).rejects.toBeInstanceOf(KicadSourceMutationError);
  });

  it("rejects non-empty output directories and source traversal", async () => {
    const design = await fixture();
    const runner: BoundedProcessRunner = async (options) => {
      const probe = probeResult(options);
      if (probe !== undefined) return probe;
      throw new Error("operational process should not run");
    };
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: design.workspace,
      projectRoot: design.project,
      executablePath: process.execPath,
      runner,
    });
    const nonEmpty = path.join(design.workspace, "non-empty");
    await mkdir(nonEmpty);
    await writeFile(path.join(nonEmpty, "existing.txt"), "keep", "utf8");
    await expect(
      adapter.exportCandidateArtifacts({
        schematicPath: design.schematic,
        pcbPath: design.pcb,
        outputDirectory: nonEmpty,
      }),
    ).rejects.toThrow(/must be empty/iu);
    await expect(
      adapter.exportCandidateArtifacts({
        schematicPath: path.join(design.project, "..", "outside.kicad_sch"),
        pcbPath: design.pcb,
        outputDirectory: path.join(design.workspace, "unused"),
      }),
    ).rejects.toThrow(/escapes/iu);
  });
});

it.skipIf(!existsSync(TEST_KICAD_CLI_PATH))(
  "fingerprints the locally installed KiCad 10 executable and its real help surface",
  async () => {
    const design = await fixture();
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: design.workspace,
      projectRoot: design.project,
      executablePath: TEST_KICAD_CLI_PATH,
    });
    expect(adapter.identity).toMatchObject({
      kind: "kicad-cli",
      path: TEST_KICAD_CLI_PATH,
      version: expect.stringMatching(/^10\./u),
      commit: expect.stringMatching(/^[0-9a-f]{7,64}$/iu),
      confirmedCapabilities: expect.arrayContaining([
        "sch erc",
        "pcb drc",
        "sch export bom",
        "sch export pdf",
        "pcb export gerbers",
        "pcb render",
      ]),
    });
    expect(adapter.identity.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const portableEvidence = adapter.portableRuntimeToolEvidence;
    expect(portableEvidence).toMatchObject({
      authority: "observed-not-authenticated",
      tool: {
        role: "native_validator",
        kind: "native_executable",
        name: "kicad-cli",
        version: adapter.identity.version,
        commit: adapter.identity.commit,
        contentIdentity: {
          digest: adapter.identity.sha256,
          size: adapter.identity.sizeBytes,
        },
      },
    });
    expect(portableEvidence.tool.helpIdentity).toMatchObject({
      algorithm: "sha256",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(portableEvidence.tool.capabilitiesIdentity).toMatchObject({
      algorithm: "sha256",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const originalHelpDigest = portableEvidence.tool.helpIdentity.digest;
    const originalHelpBytes = Buffer.from(portableEvidence.helpCaptureBytes);
    const originalCapabilityBytes = Buffer.from(portableEvidence.capabilityManifestBytes);
    const hostileHelpView = portableEvidence.helpCaptureBytes;
    const hostileCapabilityView = portableEvidence.capabilityManifestBytes;
    hostileHelpView.fill(0);
    hostileCapabilityView.fill(0);
    expect(portableEvidence.helpCaptureBytes).toEqual(originalHelpBytes);
    expect(portableEvidence.capabilityManifestBytes).toEqual(originalCapabilityBytes);
    expect(portableEvidence.helpCaptureBytes).not.toBe(portableEvidence.helpCaptureBytes);
    expect(portableEvidence.capabilityManifestBytes).not.toBe(
      portableEvidence.capabilityManifestBytes,
    );
    expect(portableContentIdentity(portableEvidence.helpCaptureBytes)).toEqual(
      portableEvidence.tool.helpIdentity,
    );
    expect(portableContentIdentity(portableEvidence.capabilityManifestBytes)).toEqual(
      portableEvidence.tool.capabilitiesIdentity,
    );
    expect(Object.isFrozen(portableEvidence)).toBe(true);
    expect(Object.isFrozen(portableEvidence.tool)).toBe(true);
    const detachedPortableEvidence = adapter.portableRuntimeToolEvidence;
    expect(detachedPortableEvidence).not.toBe(portableEvidence);
    expect(detachedPortableEvidence.tool).not.toBe(portableEvidence.tool);
    expect(detachedPortableEvidence.tool.helpIdentity.digest).toBe(originalHelpDigest);

    const referenceRoot = path.join(design.workspace, "canonical-reference");
    const runInput = path.join(design.workspace, "portable-run-input");
    const commandInput = path.join(runInput, "snapshots", "kicad_stats");
    const runPrivate = path.join(design.workspace, "portable-run-private");
    const commandOutput = path.join(runPrivate, "captures", "kicad_stats");
    await Promise.all([
      mkdir(referenceRoot),
      mkdir(commandInput, { recursive: true }),
      mkdir(commandOutput, { recursive: true }),
      ...["home", "kicad-config", "temp", "tmp"].map(async (directory) =>
        await mkdir(path.join(runPrivate, directory), { recursive: true }),
      ),
    ]);
    const runtimeSourceBytes = await readFile(design.pcb);
    await writeFile(path.join(commandInput, "robot.kicad_pcb"), runtimeSourceBytes);
    const freshPortableEvidence = adapter.portableRuntimeToolEvidence;
    const commandPlan = buildPortableKicadCommandPlanV1({
      commandKind: "kicad_stats",
      tool: freshPortableEvidence.tool,
      logicalCwd: {
        schemaVersion: "evleda.portable-path-ref.v1",
        root: "run_input",
        relativePath: "snapshots/kicad_stats",
      },
      sourcePath: {
        schemaVersion: "evleda.portable-path-ref.v1",
        root: "run_input",
        relativePath: "snapshots/kicad_stats/robot.kicad_pcb",
      },
      outputPath: {
        schemaVersion: "evleda.portable-path-ref.v1",
        root: "run_private",
        relativePath: "captures/kicad_stats/robot.stats.json",
      },
    });
    const resolved = await resolvePortableKicadCommandPlanV2({
      commandKind: "kicad_stats",
      nativeProcessPlan: buildPortableKicadNativeProcessPlanV2({
        commandKind: "kicad_stats",
        commandPlan,
      }),
      roots: { reference: referenceRoot, runInput, runPrivate },
      executablePath: TEST_KICAD_CLI_PATH,
      invocationInputSourceIdentity: portableContentIdentity(runtimeSourceBytes),
      helpCaptureBytes: freshPortableEvidence.helpCaptureBytes,
      capabilityManifestBytes: freshPortableEvidence.capabilityManifestBytes,
      privateEnvironmentPaths: {
        HOME: {
          schemaVersion: "evleda.portable-path-ref.v1",
          root: "run_private",
          relativePath: "home",
        },
        KICAD_CONFIG_HOME: {
          schemaVersion: "evleda.portable-path-ref.v1",
          root: "run_private",
          relativePath: "kicad-config",
        },
        TEMP: {
          schemaVersion: "evleda.portable-path-ref.v1",
          root: "run_private",
          relativePath: "temp",
        },
        TMP: {
          schemaVersion: "evleda.portable-path-ref.v1",
          root: "run_private",
          relativePath: "tmp",
        },
      },
    });
    expect(resolved.command).toBe(TEST_KICAD_CLI_PATH);
    expect(resolved.argv).toEqual([
      "pcb",
      "export",
      "stats",
      "--format",
      "json",
      "--output",
      path.join(commandOutput, "robot.stats.json"),
      path.join(commandInput, "robot.kicad_pcb"),
    ]);
  },
  30_000,
);

it.skipIf(!existsSync(TEST_KICAD_CLI_PATH))(
  "rejects unsupported future KiCad schematic syntax without changing native source bytes",
  async () => {
    const design = await fixture();
    await writeFile(
      design.schematic,
      "(kicad_sch (version 99999999) (generator evleda) (unsupported_future_construct))\n",
      "utf8",
    );
    const projectFile = path.join(design.project, "robot.kicad_pro");
    const before = await Promise.all([
      readFile(projectFile),
      readFile(design.schematic),
      readFile(design.pcb),
    ]);
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: design.workspace,
      projectRoot: design.project,
      executablePath: TEST_KICAD_CLI_PATH,
    });

    await expect(
      adapter.runChecks({
        schematicPath: design.schematic,
        pcbPath: design.pcb,
        outputDirectory: path.join(design.workspace, "unsupported-syntax-check"),
      }),
    ).rejects.toBeInstanceOf(KicadCliInvocationError);
    expect(await Promise.all([
      readFile(projectFile),
      readFile(design.schematic),
      readFile(design.pcb),
    ])).toEqual(before);
  },
  30_000,
);

it.skipIf(
  !existsSync(TEST_KICAD_CLI_PATH) || !existsSync(REAL_KICAD_FIXTURE_PATH),
)(
  "runs real native checks on an isolated local copy without changing its KiCad sources",
  async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "evleda-real-kicad-check-"));
    temporaryRoots.push(workspace);
    const project = path.join(workspace, "working-copy");
    await cp(REAL_KICAD_FIXTURE_PATH, project, { recursive: true });
    const schematic = path.join(project, "demo.kicad_sch");
    const pcb = path.join(project, "demo.kicad_pcb");
    const before = await Promise.all([readFile(schematic, "utf8"), readFile(pcb, "utf8")]);
    const adapter = await KicadCliAdapter.create({
      workspaceRoot: workspace,
      projectRoot: project,
      executablePath: TEST_KICAD_CLI_PATH,
    });
    const checked = await adapter.runChecks({
      schematicPath: schematic,
      pcbPath: pcb,
      outputDirectory: path.join(workspace, "native-checks"),
    });

    expect(checked.executable.version).toBe(adapter.identity.version);
    expect(checked.erc.invocation.args).toContain("--exit-code-violations");
    expect(checked.drc.invocation.args).toContain("--schematic-parity");
    expect(await Promise.all([readFile(schematic, "utf8"), readFile(pcb, "utf8")])).toEqual(
      before,
    );
  },
  60_000,
);

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createKicadTransmissionLineCalculator, KICAD_TRANSMISSION_LINE_SOURCE_COMMIT, KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION } from "../../src/integrations/kicad-transmission-line.js";
import type { BoundedProcessOptions, BoundedProcessResult } from "../../src/integrations/bounded-process.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Unsafe test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
const parameters = { EPSILONR: 4.2, H: 0.0002, T: 0.000035, PHYS_WIDTH: 0.0003,
  PHYS_LEN: 0.01, FREQUENCY: 1e9, SIGMA: 5.8e7, MURC: 1, H_T: 1, ROUGH: 0, TAND: 0.02, MUR: 1 };
const request = { model: "microstrip", operation: "analyze", parameters };
const units = (name: string) => ["H", "T", "PHYS_WIDTH", "PHYS_LEN", "H_T", "ROUGH", "PHYS_S"].includes(name) ? "m"
  : name === "FREQUENCY" ? "Hz" : name === "SIGMA" ? "S/m" : name === "ANG_L" ? "rad" : name.startsWith("Z0") ? "ohm" : "1";
function response(options: BoundedProcessOptions): { schemaVersion: number; implementationRevision: string; sourceCommit: string; model: string; operation: string;
  converged: boolean; valid: boolean; inputs: Record<string, { value: number; unit: string }>;
  results: Record<string, { value: number | null; unit: string; status: string }> } {
  const args = options.args;
  const inputs = Object.fromEntries(args.filter(arg => arg.includes("=")).map(arg => {
    const [name, value] = arg.split("="); return [name!, { value: Number(value), unit: units(name!) }];
  }));
  const coupled = args[1]!.startsWith("coupled_");
  return { schemaVersion: 2, implementationRevision: KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION, sourceCommit: KICAD_TRANSMISSION_LINE_SOURCE_COMMIT, model: args[1]!, operation: args[3]!,
    converged: true, valid: true, inputs, results: {
      PHYS_WIDTH: { value: 0.0003, unit: "m", status: "ok" }, PHYS_LEN: { value: 0.01, unit: "m", status: "ok" },
      ...(coupled ? { PHYS_S: { value: 0.0002, unit: "m", status: "ok" }, Z0_O: { value: 45.00000005, unit: "ohm", status: "ok" },
        Z0_E: { value: 70, unit: "ohm", status: "ok" }, Z_DIFF: { value: 90.08, unit: "ohm", status: "ok" } }
        : { Z0: { value: 56.5, unit: "ohm", status: "ok" } }),
    } };
}
async function fixture(mutate?: (output: ReturnType<typeof response>) => void, exitCode = 0) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "evleda-transline-test-")); directories.push(cwd);
  const executablePath = path.join(cwd, "fixture.exe");
  const bytes = Buffer.from("fixture executable identity only; never executed");
  await writeFile(executablePath, bytes);
  const runner = vi.fn(async (options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    const output = response(options); mutate?.(output);
    return { command: options.command, args: options.args, cwd: options.cwd, exitCode,
      stdout: JSON.stringify(output), stderr: "", durationMs: 1, startedAt: "2026-09-09T00:00:00Z" };
  });
  const options = { executablePath, cwd, environment: { ONLY_HOST_VALUE: "fixed" },
    expectedExecutableIdentity: { sha256: contentIdentity(bytes).digest, sizeBytes: bytes.length }, runner };
  return { calculator: await createKicadTransmissionLineCalculator(options), options, runner };
}

describe("pinned KiCad transmission-line calculator", () => {
  it("returns native analysis and supplies only the host's fixed process boundary", async () => {
    const { calculator, runner, options } = await fixture();
    const result = await calculator.calculate(request);
    expect(result.status).toBe("calculated"); expect(result.impedance.singleEndedOhm).toBe(56.5);
    expect(result.targetResidualOhm).toBeNull();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ command: options.executablePath,
      cwd: options.cwd, env: { ONLY_HOST_VALUE: "fixed" }, timeoutMs: 15000, maxOutputBytes: 65536 }));
  });
  it.each([NaN, Infinity, -1, 0])("rejects invalid dielectric input %s before execution", async EPSILONR => {
    const { calculator, runner } = await fixture();
    await expect(calculator.calculate({ ...request, parameters: { ...parameters, EPSILONR } })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
  it("requires all material inputs and refuses model-selected executable fields", async () => {
    const { calculator, runner } = await fixture();
    const { EPSILONR: omitted, ...incomplete } = parameters; void omitted;
    await expect(calculator.calculate({ ...request, parameters: incomplete })).rejects.toThrow();
    await expect(calculator.calculate({ ...request, executablePath: "other.exe" })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
  it.each(["unit", "missing", "commit", "echo", "null", "nonconvergence", "old-protocol", "revision"])("rejects malformed or contradictory native %s", async kind => {
    const { calculator } = await fixture(output => {
      if (kind === "unit") output.results.Z0!.unit = "m";
      if (kind === "missing") delete output.results.Z0;
      if (kind === "commit") output.sourceCommit = "unapproved";
      if (kind === "echo") output.inputs.EPSILONR!.value = 9;
      if (kind === "null") output.results.Z0!.value = null as unknown as number;
      if (kind === "nonconvergence") output.converged = false;
      if (kind === "old-protocol") output.schemaVersion = 1;
      if (kind === "revision") output.implementationRevision = "evleda-centered-stripline-v1";
    });
    await expect(calculator.calculate(request)).rejects.toThrow();
  });
  it("checks the executable pin before dispatch, including after factory creation", async () => {
    const { calculator, options, runner } = await fixture();
    await writeFile(options.executablePath, "changed bytes");
    await expect(calculator.calculate(request)).rejects.toThrow(/pin mismatch/);
    expect(runner).not.toHaveBeenCalled();
    await expect(createKicadTransmissionLineCalculator(options)).rejects.toThrow(/pin mismatch/);
  });
  it("rejects failed process execution", async () => {
    const { calculator } = await fixture(undefined, 1);
    await expect(calculator.calculate(request)).rejects.toThrow(/exit code 1/);
  });
  it("rejects malformed JSON and propagates bounded-process failures", async () => {
    const { calculator, runner } = await fixture();
    runner.mockResolvedValueOnce({ command: "fixture", args: [], cwd: "fixture", exitCode: 0,
      stdout: "not JSON", stderr: "", durationMs: 1, startedAt: "2026-09-09T00:00:00Z" });
    await expect(calculator.calculate(request)).rejects.toThrow();
    runner.mockRejectedValueOnce(new Error("bounded process timed out"));
    await expect(calculator.calculate(request)).rejects.toThrow(/timed out/);
  });
  it("maps differential target to odd mode and reports actual reanalysis instead of the requested target", async () => {
    const { calculator, runner } = await fixture();
    const { MUR, ...coupledParameters } = parameters; void MUR;
    const result = await calculator.calculate({ model: "coupled_microstrip", operation: "synthesize",
      parameters: { ...coupledParameters, PHYS_S: 0.0002 }, targetOhm: 90, fixed: "width" });
    expect(runner.mock.calls[0]![0].args).toContain("Z0_O=45");
    expect(result.impedance.differentialAtFrequencyOhm).toBe(90.0000001);
    expect(result.impedance.differentialAtFrequencyOhm).not.toBe(90);
    expect(result.impedance.nativeDifferentialOhm).toBe(90.08);
    expect(result.impedance.nativeDifferentialBasis).toBe("quasistatic");
    expect(result.targetResidualOhm).toBeGreaterThan(0);
  });
  it("exposes nonconvergence and missed targets without reporting a successful calculation", async () => {
    const failed = await fixture(output => { output.valid = false; output.converged = false; }, 2);
    const synthesis = { ...request, operation: "synthesize", parameters: { ...parameters, ANG_L: 0.3 }, targetOhm: 50 };
    expect((await failed.calculator.calculate(synthesis)).status).toBe("not_converged");
    const missed = await fixture(output => { output.valid = false; }, 2);
    const result = await missed.calculator.calculate(synthesis);
    expect(result.status).toBe("target_not_reached");
    expect(result.targetResidualOhm).toBe(6.5);
    expect(result.impedance.singleEndedOhm).toBe(56.5);
  });
  it("reports model-specific limits without changing native values", async () => {
    const { calculator } = await fixture();
    const single = await calculator.calculate(request);
    expect(single.modelWarnings.map(warning => warning.code)).toEqual(expect.arrayContaining([
      "NATIVE_DELAY_APPROXIMATION", "FINITE_THICKNESS_MODEL_VARIANT", "MICROSTRIP_METALLIC_COVER"]));
    expect(single.impedance.singleEndedOhm).toBe(56.5);
    const { MUR, ...coupled } = parameters; void MUR;
    const outside = await calculator.calculate({ model: "coupled_microstrip", operation: "analyze",
      parameters: { ...coupled, EPSILONR: 20, PHYS_S: 0.0002 } });
    expect(outside.modelWarnings.map(warning => warning.code)).toContain("COUPLED_MICROSTRIP_MODEL_RANGE");
    const { H_T, ROUGH, TAND, ...strip } = coupled; void H_T; void ROUGH; void TAND;
    const patched = await calculator.calculate({ model: "coupled_stripline", operation: "analyze", parameters: { ...strip, PHYS_S: 0.0002 } });
    expect(patched.modelWarnings.map(warning => warning.code)).toEqual(expect.arrayContaining([
      "COUPLED_STRIPLINE_SOURCE_CORRECTIONS", "COUPLED_STRIPLINE_PIECEWISE_INVERSE"]));
    expect(patched.modelWarnings.map(warning => warning.code)).not.toContain("FINITE_THICKNESS_MODEL_VARIANT");
    expect(patched.native.implementationRevision).toBe("evleda-stripline-corrections-v1");
  });
});

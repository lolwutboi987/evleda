import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createKicadTransmissionLineCalculator, isKicadTransmissionLineCalculator, kicadTransmissionLineRequestSchema, KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION,
  KICAD_TRANSMISSION_LINE_SOURCE_COMMIT, KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION } from "../../src/integrations/kicad-transmission-line.js";
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
const units = (name: string) => ["H", "T", "PHYS_WIDTH", "PHYS_LEN", "H_T", "ROUGH", "PHYS_S", "STRIPLINE_A"].includes(name) ? "m"
  : name === "FREQUENCY" ? "Hz" : name === "SIGMA" ? "S/m" : name === "ANG_L" ? "rad" : name.startsWith("Z0") ? "ohm" : "1";
function response(options: BoundedProcessOptions): { schemaVersion: number; implementationRevision: string; sourceCommit: string; model: string; operation: string;
  converged: boolean; valid: boolean; inputs: Record<string, { value: number | "absent"; unit: string }>;
  results: Record<string, { value: number | null; unit: string; status: string }> } {
  const args = options.args;
  const inputs = Object.fromEntries(args.filter(arg => arg.includes("=")).map(arg => {
    const [name, value] = arg.split("=");
    return [name!, name === "H_T" && value === "absent" ? { value: "absent" as const, unit: "1" }
      : { value: Number(value), unit: units(name!) }];
  }));
  const coupled = args[1]!.startsWith("coupled_");
  return { schemaVersion: KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION, implementationRevision: KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION, sourceCommit: KICAD_TRANSMISSION_LINE_SOURCE_COMMIT, model: args[1]!, operation: args[3]!,
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
  it("brands the frozen calculator returned by the factory without running the helper", async () => {
    const { calculator, runner } = await fixture();
    expect(isKicadTransmissionLineCalculator(calculator)).toBe(true);
    expect(Object.isFrozen(calculator)).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });
  it("rejects structural impostors and non-object values without reading their properties", () => {
    const calculate = vi.fn();
    const readCalculate = vi.fn(() => { throw new Error("Calculator property must not be inspected"); });
    const accessor = Object.defineProperty({}, "calculate", { get: readCalculate });
    for (const value of [null, undefined, false, 1, "calculator", Symbol("calculator"), calculate,
      {}, { calculate }, Object.freeze({ calculate }), accessor]) {
      expect(isKicadTransmissionLineCalculator(value)).toBe(false);
    }
    expect(calculate).not.toHaveBeenCalled();
    expect(readCalculate).not.toHaveBeenCalled();
  });
  it("does not transfer factory provenance through copying, inheritance, or proxy wrapping", async () => {
    const { calculator, runner } = await fixture();
    for (const copy of [{ ...calculator }, Object.freeze({ ...calculator }),
      Object.create(Object.getPrototypeOf(calculator), Object.getOwnPropertyDescriptors(calculator)),
      Object.create(calculator), new Proxy(calculator, {})]) {
      expect(isKicadTransmissionLineCalculator(copy)).toBe(false);
    }
    expect(isKicadTransmissionLineCalculator(calculator)).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });
  it("pins the explicit uncovered coupled-microstrip response contract", () => {
    expect(KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION).toBe(4);
    expect(KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION).toBe("evleda-uncovered-coupled-microstrip-v1");
  });
  it("returns native analysis and supplies only the host's fixed process boundary", async () => {
    const { calculator, runner, options } = await fixture();
    const result = await calculator.calculate(request);
    expect(result.status).toBe("calculated"); expect(result.impedance.singleEndedOhm).toBe(56.5);
    expect(result.targetResidualOhm).toBeNull();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ command: options.executablePath,
      cwd: options.cwd, env: { ONLY_HOST_VALUE: "fixed" }, timeoutMs: 15000, maxOutputBytes: 65536 }));
  });
  it.each((["microstrip", "coupled_microstrip", "stripline", "coupled_stripline"] as const).flatMap(model =>
    (["analyze", "synthesize"] as const).flatMap(operation => ([2, 3] as const).map(protocol => ({ model, operation, protocol })))))(
    "accepts the pinned protocol-$protocol numeric response for $model $operation", async ({ model, operation, protocol }) => {
      const { MUR, H_T, ROUGH, TAND, ...baseParameters } = parameters; void MUR;
      const modelParameters = {
        microstrip: parameters,
        coupled_microstrip: { ...baseParameters, H_T, ROUGH, TAND, PHYS_S: 0.0002 },
        stripline: { ...baseParameters, STRIPLINE_A: 0.00008, TAND },
        coupled_stripline: { ...baseParameters, PHYS_S: 0.0002 },
      }[model];
      const coupled = model.startsWith("coupled_");
      const input = { model, operation, parameters: { ...modelParameters,
        ...(model === "microstrip" && operation === "synthesize" ? { ANG_L: 0.3 } : {}) },
        ...(operation === "synthesize" ? { targetOhm: coupled ? 90 : 56.5,
          ...(coupled ? { fixed: "width" } : {}) } : {}) };
      const { calculator, runner } = await fixture(output => {
        output.schemaVersion = protocol;
        output.implementationRevision = protocol === 2 ? "evleda-stripline-corrections-v1" : "evleda-uncovered-microstrip-v1";
      });
      const result = await calculator.calculate(input);
      expect(result.status).toBe("calculated");
      expect(result.native.schemaVersion).toBe(protocol);
      expect(result.native.implementationRevision).toBe(protocol === 2 ? "evleda-stripline-corrections-v1" : "evleda-uncovered-microstrip-v1");
      expect(Object.values(result.native.inputs).every(input => typeof input.value === "number" && Number.isFinite(input.value))).toBe(true);
      expect(result.scope).toContain("evleda-stripline-corrections-v1");
      expect(result.scope).not.toContain("evleda-uncovered-coupled-microstrip-v1");
      expect(runner).toHaveBeenCalledTimes(1);
    });
  it.each([
    { schemaVersion: 2, implementationRevision: "evleda-uncovered-microstrip-v1" },
    { schemaVersion: 2, implementationRevision: "unapproved" },
    { schemaVersion: 3, implementationRevision: "evleda-stripline-corrections-v1" },
    { schemaVersion: 3, implementationRevision: "unapproved" },
    { schemaVersion: 3, implementationRevision: "evleda-uncovered-coupled-microstrip-v1" },
    { schemaVersion: 4, implementationRevision: "evleda-uncovered-microstrip-v1" },
    { schemaVersion: 4, implementationRevision: "unapproved" },
  ])("rejects protocol $schemaVersion with incompatible revision $implementationRevision", async identity => {
    const { calculator } = await fixture(output => { Object.assign(output, identity); });
    await expect(calculator.calculate(request)).rejects.toThrow();
  });
  it.each((["analyze", "synthesize"] as const).flatMap(operation =>
    (["numeric-cover", "crafted-absent-cover"] as const).map(echo => ({ operation, echo }))))(
    "rejects protocol-2 $echo responses for absent-cover $operation", async ({ operation, echo }) => {
      const { calculator, runner } = await fixture(output => {
        output.schemaVersion = 2;
        output.implementationRevision = "evleda-stripline-corrections-v1";
        if (echo === "numeric-cover") output.inputs.H_T = { value: 1, unit: "m" };
      });
      const input = { ...request, operation, parameters: { ...parameters, H_T: "absent",
        ...(operation === "synthesize" ? { ANG_L: 0.3 } : {}) },
        ...(operation === "synthesize" ? { targetOhm: 56.5 } : {}) };
      await expect(calculator.calculate(input)).rejects.toThrow();
      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0]![0].args).toContain("H_T=absent");
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
  it.each(["analyze", "synthesize"] as const)("accepts explicit absent cover for single microstrip %s and preserves its exact native echo", async operation => {
    const input = { ...request, operation, parameters: { ...parameters, H_T: "absent",
      ...(operation === "synthesize" ? { ANG_L: 0.3 } : {}) },
      ...(operation === "synthesize" ? { targetOhm: 56.5 } : {}) };
    expect(kicadTransmissionLineRequestSchema.parse(input)).toEqual(input);
    const { calculator, runner } = await fixture();
    const result = await calculator.calculate(input);
    expect(result.status).toBe("calculated");
    expect(result.request).toEqual(input);
    expect(result.native.inputs.H_T).toEqual({ value: "absent", unit: "1" });
    expect(runner).toHaveBeenCalledTimes(1);
    const args = runner.mock.calls[0]![0].args;
    expect(args.filter(arg => arg.startsWith("H_T="))).toEqual(["H_T=absent"]);
    const { H_T, ...finiteParameters } = input.parameters; void H_T;
    const expectedFinite = { ...finiteParameters, ...(operation === "synthesize" ? { Z0: 56.5 } : {}) };
    expect(result.native.inputs).toEqual({
      ...Object.fromEntries(Object.entries(expectedFinite).map(([name, value]) => [name, { value, unit: units(name) }])),
      H_T: { value: "absent", unit: "1" },
    });
    for (const [name, value] of Object.entries(expectedFinite)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(args).toContain(`${name}=${value}`);
    }
    expect(result.impedance.singleEndedOhm).toBe(56.5);
    expect(result.targetResidualOhm).toBe(operation === "synthesize" ? 0 : null);
    const warningCodes = result.modelWarnings.map(warning => warning.code);
    expect(warningCodes).toContain("MICROSTRIP_UNCOVERED_MODEL");
    expect(warningCodes).not.toContain("MICROSTRIP_METALLIC_COVER");
  });
  it.each([
    { operation: "analyze", H_T: 0.001 }, { operation: "analyze", H_T: 1 },
    { operation: "synthesize", H_T: 0.001 }, { operation: "synthesize", H_T: 1 },
  ] as const)("preserves finite cover $H_T for single microstrip $operation", async ({ operation, H_T }) => {
    const input = { ...request, operation, parameters: { ...parameters, H_T,
      ...(operation === "synthesize" ? { ANG_L: 0.3 } : {}) },
      ...(operation === "synthesize" ? { targetOhm: 56.5 } : {}) };
    expect(kicadTransmissionLineRequestSchema.parse(input)).toEqual(input);
    const { calculator, runner } = await fixture();
    const result = await calculator.calculate(input);
    expect(result.status).toBe("calculated");
    expect(result.request).toEqual(input);
    expect(result.native.inputs.H_T).toEqual({ value: H_T, unit: "m" });
    expect(runner.mock.calls[0]![0].args.filter(arg => arg.startsWith("H_T="))).toEqual([`H_T=${H_T}`]);
    expect(result.modelWarnings.map(warning => warning.code)).toContain("MICROSTRIP_METALLIC_COVER");
    expect(result.modelWarnings.map(warning => warning.code)).not.toContain("MICROSTRIP_UNCOVERED_MODEL");
  });
  it.each([
    { operation: "analyze" as const, fixed: undefined },
    { operation: "synthesize" as const, fixed: "width" as const },
    { operation: "synthesize" as const, fixed: "spacing" as const },
  ])("accepts absent coupled-microstrip cover for $operation fixed=$fixed and preserves the topology warning", async ({ operation, fixed }) => {
    const { MUR, ...coupledParameters } = parameters; void MUR;
    const input = { model: "coupled_microstrip", operation, parameters: { ...coupledParameters, H_T: "absent", PHYS_S: 0.0002 },
      ...(operation === "synthesize" ? { targetOhm: 90, fixed } : {}) };
    expect(kicadTransmissionLineRequestSchema.parse(input)).toEqual(input);
    const { calculator, runner } = await fixture();
    const result = await calculator.calculate(input);
    expect(result.status).toBe("calculated");
    expect(result.native.inputs.H_T).toEqual({ value: "absent", unit: "1" });
    expect(runner.mock.calls[0]![0].args.filter(arg => arg.startsWith("H_T="))).toEqual(["H_T=absent"]);
    expect(result.modelWarnings.map(warning => warning.code)).toContain("COUPLED_MICROSTRIP_UNCOVERED_MODEL");
    expect(result.modelWarnings.map(warning => warning.code)).not.toContain("MICROSTRIP_METALLIC_COVER");
    expect(result.impedance.nativeDifferentialBasis).toBe("quasistatic");
    expect(result.impedance.differentialAtFrequencyOhm).toBe(90.0000001);
    if (fixed !== undefined) {
      expect(runner.mock.calls[0]![0].args).toEqual(expect.arrayContaining(["--fix", fixed, "Z0_O=45"]));
      expect(result.targetResidualOhm).toBeCloseTo(0.0000001, 12);
    }
  });
  it.each(["analyze", "synthesize"] as const)("retains protocol-3 single absent-cover %s compatibility", async operation => {
    const { calculator } = await fixture(output => {
      output.schemaVersion = 3;
      output.implementationRevision = "evleda-uncovered-microstrip-v1";
    });
    const result = await calculator.calculate({ ...request, operation,
      parameters: { ...parameters, H_T: "absent", ...(operation === "synthesize" ? { ANG_L: 0.3 } : {}) },
      ...(operation === "synthesize" ? { targetOhm: 56.5 } : {}) });
    expect(result.native.schemaVersion).toBe(3);
    expect(result.native.inputs.H_T).toEqual({ value: "absent", unit: "1" });
    expect(result.status).toBe("calculated");
    expect(result.scope).toContain("explicit uncovered single-microstrip support");
    expect(result.scope).not.toContain("single/coupled-microstrip support");
  });
  it.each(([2, 3] as const).flatMap(protocol => (["analyze", "synthesize"] as const).flatMap(operation =>
    (["numeric", "crafted-absent"] as const).map(echo => ({ protocol, operation, echo })))))(
    "rejects protocol-$protocol coupled absent-cover $operation with $echo echo", async ({ protocol, operation, echo }) => {
      const { MUR, ...coupledParameters } = parameters; void MUR;
      const { calculator, runner } = await fixture(output => {
        output.schemaVersion = protocol;
        output.implementationRevision = protocol === 2 ? "evleda-stripline-corrections-v1" : "evleda-uncovered-microstrip-v1";
        if (echo === "numeric") output.inputs.H_T = { value: 1, unit: "m" };
      });
      await expect(calculator.calculate({ model: "coupled_microstrip", operation,
        parameters: { ...coupledParameters, H_T: "absent", PHYS_S: 0.0002 },
        ...(operation === "synthesize" ? { targetOhm: 90, fixed: "width" } : {}) })).rejects.toThrow();
      expect(runner.mock.calls[0]![0].args).toContain("H_T=absent");
  });
  it.each(["none", "infinite", "Infinity", "Absent", " absent", "1", "", null, undefined, {}, NaN, Infinity, -Infinity, 0, -1]
    .flatMap(H_T => (["microstrip", "coupled_microstrip"] as const).map(model => ({ H_T, model }))))(
    "rejects unsupported or nonfinite H_T=$H_T for $model before execution", async ({ H_T, model }) => {
      const { MUR, ...coupledParameters } = parameters; void MUR;
      const input = { ...request, model, parameters: { ...(model === "microstrip" ? parameters : { ...coupledParameters, PHYS_S: 0.0002 }), H_T } };
      expect(kicadTransmissionLineRequestSchema.safeParse(input).success).toBe(false);
      const { calculator, runner } = await fixture();
      await expect(calculator.calculate(input)).rejects.toThrow();
      expect(runner).not.toHaveBeenCalled();
    });
  it.each(["analyze", "synthesize"] as const)("requires an explicit H_T for microstrip %s", async operation => {
    const { H_T, ...withoutCover } = parameters; void H_T;
    const input = { ...request, operation, parameters: { ...withoutCover,
      ...(operation === "synthesize" ? { ANG_L: 0.3 } : {}) },
      ...(operation === "synthesize" ? { targetOhm: 56.5 } : {}) };
    expect(kicadTransmissionLineRequestSchema.safeParse(input).success).toBe(false);
    const { calculator, runner } = await fixture();
    await expect(calculator.calculate(input)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
  it.each(["finite-height", "wrong-unit", "missing-cover", "absent-other-input", "nonfinite-other-input"])(
    "rejects contradictory native absent-cover echo: %s", async kind => {
      const { calculator, runner } = await fixture(output => {
        if (kind === "finite-height") output.inputs.H_T = { value: 1, unit: "m" };
        if (kind === "wrong-unit") output.inputs.H_T!.unit = "m";
        if (kind === "missing-cover") delete output.inputs.H_T;
        if (kind === "absent-other-input") output.inputs.EPSILONR = { value: "absent", unit: "1" };
        if (kind === "nonfinite-other-input") output.inputs.EPSILONR!.value = Infinity;
      });
      await expect(calculator.calculate({ ...request, parameters: { ...parameters, H_T: "absent" } })).rejects.toThrow();
      expect(runner).toHaveBeenCalledTimes(1);
    });
  it("rejects an absent native echo for a requested finite cover", async () => {
    const { calculator } = await fixture(output => { output.inputs.H_T = { value: "absent", unit: "1" }; });
    await expect(calculator.calculate(request)).rejects.toThrow(/does not match the requested inputs/);
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
      if (kind === "revision") output.implementationRevision = "evleda-stripline-corrections-v1";
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
    expect(outside.modelWarnings.map(warning => warning.code)).toContain("MICROSTRIP_METALLIC_COVER");
    expect(outside.modelWarnings.map(warning => warning.code)).not.toContain("MICROSTRIP_UNCOVERED_MODEL");
    const { H_T, ROUGH, TAND, ...strip } = coupled; void H_T; void ROUGH; void TAND;
    const patched = await calculator.calculate({ model: "coupled_stripline", operation: "analyze", parameters: { ...strip, PHYS_S: 0.0002 } });
    expect(patched.modelWarnings.map(warning => warning.code)).toEqual(expect.arrayContaining([
      "COUPLED_STRIPLINE_SOURCE_CORRECTIONS", "COUPLED_STRIPLINE_PIECEWISE_INVERSE"]));
    expect(patched.modelWarnings.map(warning => warning.code)).not.toContain("FINITE_THICKNESS_MODEL_VARIANT");
    expect(patched.native.implementationRevision).toBe(KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION);
  });
});

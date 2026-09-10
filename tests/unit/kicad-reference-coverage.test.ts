import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { createReferenceCoverageCalculator, type ReferenceCoverageRequest } from "../../src/integrations/kicad-reference-coverage.js";
import type { BoundedProcessOptions, BoundedProcessResult } from "../../src/integrations/bounded-process.js";

const owned: string[] = [];
afterEach(async () => {
  for (const directory of owned.splice(0)) {
    if (!directory.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error("Unsafe test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
const request: ReferenceCoverageRequest = { groups: [{ rings: [[[-1000, -1000], [1000, -1000], [1000, 1000], [-1000, 1000]]] }],
  routes: [{ x1Nm: -100, y1Nm: 0, x2Nm: 100, y2Nm: 0, widthNm: 100, marginNm: 25 }] };
const envelope = [[[-175, -75], [175, -75], [175, 75], [-175, 75]]];
function output(echo: string) { return { schemaVersion: 1, implementationRevision: "evleda-reference-coverage-v1",
  sourceCommit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", clipperVersion: "1.3.0", inputBase64: echo,
  coordinateUnit: "nm", normalizedCopper: structuredClone(request.groups[0]!.rings),
  routes: [{ routeIndex: 0, status: "covered", certificate: "exact_outer_envelope_containment",
    innerEnvelope: structuredClone(envelope), outerEnvelope: structuredClone(envelope), uncoveredOuterEnvelope: [] as number[][][], outsideWitnessDoubledNm: undefined as number[] | undefined }],
  diagnosticGeometry: "clipper_integer_quantized_not_a_continuous_geometry_proof",
  envelopeModel: "inner_L1_diamond_floor_radius_outer_Linf_square_ceil_radius",
  coverageMeaning: "closed_Euclidean_segment_ribbon_radius_width_over_two_plus_margin",
  dcConnectivityClaimed: false, hfElectricalValidityClaimed: false };
}
async function fixture(mutate?: (value: ReturnType<typeof output>) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-reference-coverage-")); owned.push(root);
  const executablePath = path.join(root, "fixture.exe"), bytes = Buffer.from("pinned fixture; not executed");
  await writeFile(executablePath, bytes);
  const runner = vi.fn(async (options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    const value = output((await readFile(options.args[1]!)).toString("base64")); mutate?.(value);
    return { command: options.command, args: options.args, cwd: options.cwd,
      exitCode: 0, stdout: JSON.stringify(value), stderr: "", durationMs: 1, startedAt: "2026-09-09T00:00:00Z" };
  });
  const options = { executablePath, expectedExecutableIdentity: { sha256: contentIdentity(bytes).digest, sizeBytes: bytes.length },
    cwd: root, outputRoot: root, environment: { HOST_ONLY: "fixed" }, runner };
  return { options, runner, calculator: await createReferenceCoverageCalculator(options) };
}
describe("host-bound reference coverage adapter", () => {
  it("binds exact request bytes and retains raw artifacts without returning the echo", async () => {
    const { calculator, runner, options } = await fixture();
    const result = await calculator.calculate(request);
    expect(result.routes[0]!.status).toBe("covered"); expect(result).not.toHaveProperty("inputBase64");
    expect(contentIdentity(await readFile(result.artifacts.input.path))).toEqual(result.artifacts.input.identity);
    expect(contentIdentity(await readFile(result.artifacts.rawOutput.path))).toEqual(result.artifacts.rawOutput.identity);
    expect(await readFile(result.artifacts.input.path, "utf8")).toContain("ROUTE -100 0 100 0 100 25\nEND\n");
    expect(runner.mock.calls[0]![0]).toMatchObject({ command: options.executablePath, cwd: options.cwd, env: options.environment });
    expect(runner.mock.calls[0]![0].args).toEqual(["--input", result.artifacts.input.path]);
  });
  it.each(["fraction", "nan", "zero-width", "no-margin", "zero-route", "closing-vertex", "envelope-bound", "groups", "routes", "collinear"])("rejects invalid %s geometry before execution", async kind => {
    const { calculator, runner } = await fixture();
    const input = structuredClone(request);
    if (kind === "fraction") input.groups[0]!.rings[0]![0]![0] = 0.5;
    if (kind === "nan") input.routes[0]!.marginNm = NaN;
    if (kind === "zero-width") input.routes[0]!.widthNm = 0;
    if (kind === "no-margin") delete (input.routes[0] as Partial<typeof input.routes[number]>).marginNm;
    if (kind === "zero-route") input.routes[0]!.x2Nm = -100;
    if (kind === "closing-vertex") input.groups[0]!.rings[0]!.push([-1000, -1000]);
    if (kind === "envelope-bound") input.routes[0]!.x2Nm = 2_000_000_000;
    if (kind === "groups") input.groups = Array.from({ length: 129 }, () => request.groups[0]!);
    if (kind === "routes") input.routes = Array.from({ length: 65 }, () => request.routes[0]!);
    if (kind === "collinear") input.groups[0]!.rings = [[[0, 0], [1, 0], [2, 0]]];
    await expect(calculator.calculate(input)).rejects.toThrow(); expect(runner).not.toHaveBeenCalled();
  });
  it.each(["echo", "revision", "unit", "fraction", "bounds", "count", "certificate", "witness", "electrical"])("rejects invalid %s output", async kind => {
    const { calculator } = await fixture(value => {
      if (kind === "echo") value.inputBase64 += "AAAA";
      if (kind === "revision") value.implementationRevision = "other";
      if (kind === "unit") value.coordinateUnit = "mm";
      if (kind === "fraction") value.routes[0]!.outerEnvelope[0]![0]![0] = 0.5;
      if (kind === "bounds") value.routes[0]!.outerEnvelope[0]![0]![0] = 2_000_000_001;
      if (kind === "count") value.routes = [];
      if (kind === "certificate") value.routes[0]!.certificate = "no_exact_certificate";
      if (kind === "witness") value.routes[0]!.outsideWitnessDoubledNm = [0, 0];
      if (kind === "electrical") value.dcConnectivityClaimed = true;
    });
    await expect(calculator.calculate(request)).rejects.toThrow();
  });
  it("rejects pin drift and failed/malformed/oversized process output", async () => {
    const { calculator, runner, options } = await fixture();
    runner.mockRejectedValueOnce(new Error("process output limit"));
    await expect(calculator.calculate(request)).rejects.toThrow(/output limit/);
    runner.mockResolvedValueOnce({ command: "fixture", args: [], cwd: options.cwd, exitCode: 0,
      stdout: "not json", stderr: "", durationMs: 1, startedAt: "now" });
    await expect(calculator.calculate(request)).rejects.toThrow();
    runner.mockResolvedValueOnce({ command: "fixture", args: [], cwd: options.cwd, exitCode: 0,
      stdout: " ".repeat(16 * 1024 * 1024 + 2), stderr: "", durationMs: 1, startedAt: "now" });
    await expect(calculator.calculate(request)).rejects.toThrow(/byte limit/);
    await writeFile(options.executablePath, "changed");
    await expect(calculator.calculate(request)).rejects.toThrow(/pin mismatch/);
  });
  it("treats helper error envelopes as errors and never coverage results", async () => {
    const { calculator, runner } = await fixture();
    runner.mockImplementationOnce(async options => {
      const value = output((await readFile(options.args[1]!)).toString("base64"));
      return { command: options.command, args: options.args, cwd: options.cwd, exitCode: 1,
        stdout: JSON.stringify({ schemaVersion: value.schemaVersion, implementationRevision: value.implementationRevision,
          sourceCommit: value.sourceCommit, clipperVersion: value.clipperVersion, inputBase64: value.inputBase64, error: "predicate_work_limit" }),
        stderr: "", durationMs: 1, startedAt: "now" };
    });
    await expect(calculator.calculate(request)).rejects.toThrow(/predicate_work_limit/);
  });
  it.skipIf(process.env.EVLEDA_TEST_REFERENCE_COVERAGE_NATIVE !== "1")("runs covered and uncovered cases through the pinned actual helper", async () => {
    const { options } = await fixture();
    const executablePath = "D:/EvlEDA-reference-coverage-helper-20260909/reference-coverage.exe";
    const calculator = await createReferenceCoverageCalculator({ executablePath,
      expectedExecutableIdentity: { sha256: "8140d71004fb800da885bc91337e11effbda1b50ba6530741252dcfda85ed8d7", sizeBytes: 980480 },
      cwd: options.cwd, outputRoot: options.outputRoot, environment: { SYSTEMROOT: "C:/Windows", WINDIR: "C:/Windows" } });
    expect((await calculator.calculate(request)).routes[0]!.status).toBe("covered");
    const absent = await calculator.calculate({ ...request, groups: [] });
    expect(absent.routes[0]!.status).toBe("uncovered");
    expect(absent.routes[0]!.outsideWitnessDoubledNm).toBeDefined();
  });
});

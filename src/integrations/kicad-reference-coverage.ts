import { lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentIdentity } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import type { ContentIdentity } from "../domain/types.js";
import { runBoundedProcess, type BoundedProcessRunner, type BoundedWindowsProcessTreeTermination } from "./bounded-process.js";

export const REFERENCE_COVERAGE_IMPLEMENTATION_REVISION = "evleda-reference-coverage-v1";
const BOUND = 2_000_000_000;
const MAX_INPUT = 8 * 1024 * 1024;
// Includes trailing LF: slightly stricter than the helper's pre-LF 16 MiB cap.
const MAX_OUTPUT = 16 * 1024 * 1024;
const coordinate = z.number().int().min(-BOUND).max(BOUND);
const point = z.tuple([coordinate, coordinate]);
export const referenceCoverageRequestSchema = z.object({
  groups: z.array(z.object({ rings: z.array(z.array(point).min(3).max(8192)).min(1).max(512) }).strict()).max(128),
  routes: z.array(z.object({ x1Nm: coordinate, y1Nm: coordinate, x2Nm: coordinate, y2Nm: coordinate,
    widthNm: z.number().int().positive().max(BOUND), marginNm: z.number().int().nonnegative().max(BOUND)
      .describe("Explicit geometric margin beyond the trace edge in integer nanometres; no electrical default") }).strict()).min(1).max(64),
}).strict().superRefine((request, ctx) => {
  let ringCount = 0, vertexCount = 0;
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  for (const group of request.groups) for (const ring of group.rings) {
    ringCount++; vertexCount += ring.length;
    let area = 0n;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      if (a[0] === b[0] && a[1] === b[1]) fail("Ring has a zero-length edge or repeated closing vertex");
      area += BigInt(a[0]) * BigInt(b[1]) - BigInt(a[1]) * BigInt(b[0]);
    }
    if (area === 0n) fail("Ring has zero signed area");
  }
  if (ringCount > 512 || vertexCount > 8192) fail("Aggregate ring or vertex limit exceeded");
  for (const route of request.routes) {
    if (route.x1Nm === route.x2Nm && route.y1Nm === route.y2Nm) fail("Route endpoints must differ");
    const radius = Math.ceil(route.widthNm / 2 + route.marginNm);
    if ([route.x1Nm, route.y1Nm, route.x2Nm, route.y2Nm].some(value => Math.abs(value) + radius > BOUND)) fail("Route outer envelope exceeds coordinate bounds");
  }
});
export type ReferenceCoverageRequest = z.infer<typeof referenceCoverageRequestSchema>;

const identityFields = { schemaVersion: z.literal(1), implementationRevision: z.literal(REFERENCE_COVERAGE_IMPLEMENTATION_REVISION),
  sourceCommit: z.literal("146a4f2a7585c65bc580427a19b6fe2ec4a3f622"), clipperVersion: z.literal("1.3.0") };
const polygons = z.array(z.array(point).max(65536)).max(65536);
const routeResult = z.object({ routeIndex: z.number().int().min(0).max(63),
  status: z.enum(["covered", "uncovered", "boundary_uncertain"]),
  certificate: z.enum(["exact_outer_envelope_containment", "exact_inner_envelope_outside_witness", "no_exact_certificate"]),
  innerEnvelope: polygons.length(1), outerEnvelope: polygons.length(1), uncoveredOuterEnvelope: polygons,
  outsideWitnessDoubledNm: z.tuple([z.number().int().min(-2 * BOUND).max(2 * BOUND), z.number().int().min(-2 * BOUND).max(2 * BOUND)]).optional(),
}).strict();
const responseSchema = z.object({ ...identityFields, inputBase64: z.string(), coordinateUnit: z.literal("nm"),
  normalizedCopper: polygons, routes: z.array(routeResult).min(1).max(64),
  diagnosticGeometry: z.literal("clipper_integer_quantized_not_a_continuous_geometry_proof"),
  envelopeModel: z.literal("inner_L1_diamond_floor_radius_outer_Linf_square_ceil_radius"),
  coverageMeaning: z.literal("closed_Euclidean_segment_ribbon_radius_width_over_two_plus_margin"),
  dcConnectivityClaimed: z.literal(false), hfElectricalValidityClaimed: z.literal(false),
}).strict();
const errorSchema = z.object({ ...identityFields, error: z.string().regex(/^[a-z_]{1,64}$/u), inputBase64: z.string() }).strict();
export interface ReferenceCoverageOptions {
  readonly executablePath: string;
  readonly expectedExecutableIdentity: Readonly<{ sha256: string; sizeBytes: number }>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly outputRoot: string;
  readonly runner?: BoundedProcessRunner;
  readonly windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination;
}
export type ReferenceCoverageResult = Omit<z.infer<typeof responseSchema>, "inputBase64"> & {
  readonly artifacts: Readonly<{ input: Readonly<{ path: string; identity: ContentIdentity }>;
    rawOutput: Readonly<{ path: string; identity: ContentIdentity }> }>;
  readonly executableIdentity: Readonly<{ sha256: string; sizeBytes: number }>;
};
export interface ReferenceCoverageCalculator { calculate(request: unknown): Promise<ReferenceCoverageResult> }
const calculators = new WeakSet<object>();
/** Factory provenance for engineering row evaluators; caller-supplied functions are not pinned helpers. */
export function isReferenceCoverageCalculator(value: unknown): value is ReferenceCoverageCalculator {
  return value !== null && typeof value === "object" && calculators.has(value);
}

function serialize(request: ReferenceCoverageRequest): Buffer {
  const lines = ["EVLEDA_REFERENCE_COVERAGE 1", `GROUPS ${request.groups.length}`];
  for (const group of request.groups) {
    lines.push(`GROUP ${group.rings.length}`);
    for (const ring of group.rings) { lines.push(`RING ${ring.length}`); for (const [x, y] of ring) lines.push(`${x} ${y}`); }
  }
  lines.push(`ROUTES ${request.routes.length}`);
  for (const r of request.routes) lines.push(`ROUTE ${r.x1Nm} ${r.y1Nm} ${r.x2Nm} ${r.y2Nm} ${r.widthNm} ${r.marginNm}`);
  lines.push("END", "");
  const bytes = Buffer.from(lines.join("\n"), "ascii");
  if (bytes.length > MAX_INPUT) throw new Error("Reference coverage input byte limit exceeded.");
  return bytes;
}

/** Host-owned geometry computation only; no document freshness or electrical claims. */
export async function createReferenceCoverageCalculator(options: ReferenceCoverageOptions): Promise<ReferenceCoverageCalculator> {
  const command = options.executablePath;
  const pin = Object.freeze({ ...options.expectedExecutableIdentity });
  if (![command, options.cwd, options.outputRoot].every(value => path.isAbsolute(value))
      || !/^[a-f0-9]{64}$/u.test(pin.sha256) || !Number.isSafeInteger(pin.sizeBytes)
      || pin.sizeBytes < 1 || pin.sizeBytes > 128 * 1024 * 1024) throw new Error("Reference coverage requires absolute host paths and an exact executable pin.");
  for (const directory of [options.cwd, options.outputRoot]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Reference coverage host directories must be ordinary directories.");
  }
  const cwd = await realpath(options.cwd), outputRoot = await realpath(options.outputRoot);
  const environment = Object.freeze({ ...options.environment });
  const runner = options.runner ?? runBoundedProcess;
  const termination = options.windowsProcessTreeTermination;
  async function assertPin() {
    const before = await lstat(command);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== pin.sizeBytes) throw new Error("Reference coverage executable pin mismatch.");
    const bytes = await readFile(command), after = await lstat(command);
    if (contentIdentity(bytes).digest !== pin.sha256 || bytes.length !== pin.sizeBytes || !after.isFile() || after.isSymbolicLink()
        || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Reference coverage executable pin mismatch or drift.");
  }
  await assertPin();
  const calculator = Object.freeze({ calculate: async (input: unknown): Promise<ReferenceCoverageResult> => {
    const request = referenceCoverageRequestSchema.parse(input), bytes = serialize(request);
    await assertPin();
    const directory = await mkdtemp(path.join(outputRoot, "reference-coverage-"));
    const inputPath = path.join(directory, "request.txt"), outputPath = path.join(directory, "raw-output.json");
    await writeFile(inputPath, bytes, { flag: "wx" });
    const result = await runner({ command, args: ["--input", inputPath], cwd, env: environment,
      timeoutMs: 30_000, maxOutputBytes: MAX_OUTPUT,
      ...(termination === undefined ? {} : { windowsProcessTreeTermination: termination }) });
    await assertPin();
    const raw = Buffer.from(result.stdout, "utf8");
    if (raw.length > MAX_OUTPUT) throw new Error("Reference coverage output byte limit exceeded.");
    await writeFile(outputPath, raw, { flag: "wx" });
    if (!(await readFile(inputPath)).equals(bytes)) throw new Error("Reference coverage input artifact changed during calculation.");
    const parsed = parsePortableJsonBytes(raw, { maxBytes: MAX_OUTPUT, maxDepth: 12, maxNodes: 500_000,
      maxArrayLength: 65536, maxOwnKeys: 64, maxStringBytes: 1024 * 1024 });
    if (result.exitCode !== 0) {
      const failure = errorSchema.parse(parsed);
      if (failure.inputBase64 !== bytes.toString("base64")) throw new Error("Reference coverage error input echo mismatch.");
      throw new Error(`Reference coverage helper failed (${failure.error}); raw output: ${outputPath}`);
    }
    const output = responseSchema.parse(parsed);
    if (output.inputBase64 !== bytes.toString("base64")) throw new Error("Reference coverage input echo mismatch.");
    if (output.routes.length !== request.routes.length) throw new Error("Reference coverage route count mismatch.");
    if (output.normalizedCopper.some(ring => ring.length < 3)) throw new Error("Reference coverage normalized polygon is degenerate.");
    let vertices = output.normalizedCopper.reduce((sum, ring) => sum + ring.length, 0);
    for (const [index, route] of output.routes.entries()) {
      if (route.routeIndex !== index || route.outerEnvelope[0]!.length < 3) throw new Error("Reference coverage route index or outer envelope invalid.");
      if (route.innerEnvelope[0]!.length > 0 && route.innerEnvelope[0]!.length < 3
          || route.uncoveredOuterEnvelope.some(ring => ring.length < 3)) throw new Error("Reference coverage diagnostic polygon is degenerate.");
      const certificate = route.status === "covered" ? "exact_outer_envelope_containment"
        : route.status === "uncovered" ? "exact_inner_envelope_outside_witness" : "no_exact_certificate";
      if (route.certificate !== certificate || (route.status === "uncovered") !== (route.outsideWitnessDoubledNm !== undefined)
          || route.status === "uncovered" && route.innerEnvelope[0]!.length < 3) throw new Error("Reference coverage certificate metadata contradicts its status.");
      for (const paths of [route.innerEnvelope, route.outerEnvelope, route.uncoveredOuterEnvelope]) for (const ring of paths) vertices += ring.length;
    }
    if (vertices > 65536) throw new Error("Reference coverage output vertex limit exceeded.");
    const { inputBase64: discardedEcho, ...geometry } = output; void discardedEcho;
    return Object.freeze({ ...geometry, artifacts: Object.freeze({ input: Object.freeze({ path: inputPath, identity: contentIdentity(bytes) }),
      rawOutput: Object.freeze({ path: outputPath, identity: contentIdentity(raw) }) }), executableIdentity: pin });
  } });
  calculators.add(calculator);
  return calculator;
}

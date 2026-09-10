import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import { runBoundedProcess, type BoundedProcessRunner, type BoundedWindowsProcessTreeTermination } from "./bounded-process.js";

export const KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION = 3;
export const KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION = "evleda-uncovered-microstrip-v1";
export const KICAD_TRANSMISSION_LINE_SOURCE_COMMIT = "146a4f2a7585c65bc580427a19b6fe2ec4a3f622";
const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const base = { EPSILONR: z.number().finite().min(1).describe("Relative dielectric permittivity at the requested frequency"),
  H: positive.describe("Dielectric height for microstrip; plane separation for stripline, metres"),
  T: positive.describe("Conductor thickness, metres"), PHYS_WIDTH: positive.describe("Conductor width or synthesis seed, metres"),
  PHYS_LEN: nonnegative.describe("Line length, metres"), FREQUENCY: positive.describe("Frequency, Hz"),
  SIGMA: positive.describe("Conductor conductivity, S/m"), MURC: positive.describe("Relative conductor permeability") };
const micro = { H_T: positive.describe("Metallic top enclosure height, metres; this is not a solder-mask layer"),
  ROUGH: nonnegative.describe("Conductor roughness, metres"), TAND: nonnegative.describe("Dielectric loss tangent") };
const singleMicro = z.object({ ...base, ...micro,
  H_T: z.union([positive, z.literal("absent")]).describe("Metallic top enclosure height in metres, or 'absent' for the exact uncovered single-microstrip model; does not represent solder mask"),
  MUR: positive.describe("Relative substrate permeability") }).strict();
const coupledMicro = z.object({ ...base, ...micro, PHYS_S: positive.describe("Edge-to-edge spacing or synthesis seed, metres") }).strict();
const singleStrip = z.object({ ...base, STRIPLINE_A: positive.describe("Top dielectric offset, metres"), TAND: nonnegative }).strict();
const coupledStrip = z.object({ ...base, PHYS_S: positive.describe("Edge-to-edge spacing or synthesis seed, metres") }).strict();
const targetOhm = positive.describe("Target single-ended impedance, or differential impedance for coupled models, ohms");
const fixed = z.enum(["width", "spacing"]).describe("Coupled synthesis holds this dimension fixed and solves the other");

/** SI inputs only. Convert manufacturing millimetres to metres explicitly; no material defaults. */
export const kicadTransmissionLineRequestSchema = z.union([
  z.object({ model: z.literal("microstrip"), operation: z.literal("analyze"), parameters: singleMicro }).strict(),
  z.object({ model: z.literal("microstrip"), operation: z.literal("synthesize"), parameters: singleMicro.extend({ ANG_L: nonnegative.describe("Target electrical length, radians") }), targetOhm }).strict(),
  z.object({ model: z.literal("coupled_microstrip"), operation: z.literal("analyze"), parameters: coupledMicro }).strict(),
  z.object({ model: z.literal("coupled_microstrip"), operation: z.literal("synthesize"), parameters: coupledMicro, targetOhm, fixed }).strict(),
  z.object({ model: z.literal("stripline"), operation: z.literal("analyze"), parameters: singleStrip }).strict(),
  z.object({ model: z.literal("stripline"), operation: z.literal("synthesize"), parameters: singleStrip, targetOhm }).strict(),
  z.object({ model: z.literal("coupled_stripline"), operation: z.literal("analyze"), parameters: coupledStrip }).strict(),
  z.object({ model: z.literal("coupled_stripline"), operation: z.literal("synthesize"), parameters: coupledStrip, targetOhm, fixed }).strict(),
]).superRefine((value, ctx) => {
  if (value.model.includes("stripline") && value.parameters.T >= value.parameters.H) ctx.addIssue({ code: "custom", message: "Strip thickness must be below plane separation" });
  if (value.model === "stripline" && value.parameters.STRIPLINE_A + value.parameters.T >= value.parameters.H) ctx.addIssue({ code: "custom", message: "Stripline offset plus thickness must be below plane separation" });
});
export type KicadTransmissionLineRequest = z.infer<typeof kicadTransmissionLineRequestSchema>;

export interface KicadTransmissionLineOptions {
  readonly executablePath: string;
  readonly expectedExecutableIdentity: Readonly<{ sha256: string; sizeBytes: number }>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly windowsProcessTreeTermination?: BoundedWindowsProcessTreeTermination;
  /** Host/test seam; never model input. Production uses runBoundedProcess. */
  readonly runner?: BoundedProcessRunner;
  readonly timeoutMs?: number;
}

const names = ["EPSILONR", "TAND", "RHO", "H", "H_T", "T", "PHYS_WIDTH", "PHYS_DIAM_IN", "PHYS_S", "PHYS_DIAM_OUT", "PHYS_LEN", "ROUGH", "MUR", "MURC", "FREQUENCY", "STRIPLINE_A", "TWISTEDPAIR_TWIST", "TWISTEDPAIR_EPSILONR_ENV", "Z0", "Z0_E", "Z0_O", "ANG_L", "DUMMY_PRM", "SIGMA", "SKIN_DEPTH", "LOSS_DIELECTRIC", "LOSS_CONDUCTOR", "CUTOFF_FREQUENCY", "EPSILON_EFF", "EPSILON_EFF_EVEN", "EPSILON_EFF_ODD", "UNIT_PROP_DELAY", "UNIT_PROP_DELAY_ODD", "UNIT_PROP_DELAY_EVEN", "ATTEN_COND", "ATTEN_COND_EVEN", "ATTEN_COND_ODD", "ATTEN_DILECTRIC", "ATTEN_DILECTRIC_EVEN", "ATTEN_DILECTRIC_ODD", "Z_DIFF"] as const;
function unit(name: string): string {
  if (name === "FREQUENCY" || name === "CUTOFF_FREQUENCY") return "Hz";
  if (name === "SIGMA") return "S/m";
  if (name === "ANG_L") return "rad";
  if (name.startsWith("Z0") || name === "Z_DIFF") return "ohm";
  if (name.startsWith("UNIT_PROP_DELAY")) return "ps/cm";
  if (name.startsWith("ATTEN_") || name.startsWith("LOSS_")) return "dB";
  if (["H", "H_T", "T", "PHYS_WIDTH", "PHYS_S", "PHYS_LEN", "ROUGH", "STRIPLINE_A", "SKIN_DEPTH"].includes(name)) return "m";
  return "1";
}
const numericNativeInputSchema = z.object({ value: z.number().finite(), unit: z.string() }).strict();
const nativeResponseFields = {
  sourceCommit: z.literal(KICAD_TRANSMISSION_LINE_SOURCE_COMMIT), model: z.string(), operation: z.string(),
  converged: z.boolean(), valid: z.boolean(),
  inputs: z.record(z.string(), z.union([
    numericNativeInputSchema,
    z.object({ value: z.literal("absent"), unit: z.literal("1") }).strict(),
  ])),
  results: z.record(z.string(), z.object({ value: z.number().finite().nullable(), status: z.enum(["ok", "warning", "error"]), unit: z.string() }).strict()),
};
const nativeResponseSchema = z.discriminatedUnion("schemaVersion", [
  z.object({ ...nativeResponseFields, schemaVersion: z.literal(KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION),
    implementationRevision: z.literal(KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION) }).strict(),
  // Existing pinned protocol-2 helpers remain valid for their original numeric-input contract.
  z.object({ ...nativeResponseFields, schemaVersion: z.literal(2),
    implementationRevision: z.literal("evleda-stripline-corrections-v1"),
    inputs: z.record(z.string(), numericNativeInputSchema) }).strict(),
]);
export type KicadTransmissionLineNativeResult = z.infer<typeof nativeResponseSchema>;
export interface KicadTransmissionLineModelWarning {
  readonly code: "NATIVE_DELAY_APPROXIMATION" | "FINITE_THICKNESS_MODEL_VARIANT" | "COUPLED_MICROSTRIP_MODEL_RANGE"
    | "MICROSTRIP_METALLIC_COVER" | "MICROSTRIP_UNCOVERED_MODEL" | "COUPLED_STRIPLINE_SOURCE_CORRECTIONS" | "COUPLED_STRIPLINE_PIECEWISE_INVERSE"
    | "COUPLED_MICROSTRIP_DIFFERENTIAL_BASIS";
  readonly message: string;
  readonly affectedResults: readonly string[];
}
export interface KicadTransmissionLineResult {
  readonly status: "calculated" | "not_converged" | "target_not_reached" | "invalid_model_result";
  readonly request: KicadTransmissionLineRequest;
  readonly native: KicadTransmissionLineNativeResult;
  readonly impedance: Readonly<{ singleEndedOhm: number | null; oddModeOhm: number | null;
    differentialAtFrequencyOhm: number | null; nativeDifferentialOhm: number | null;
    nativeDifferentialBasis: "not-applicable" | "quasistatic" | "native-coupled-stripline" }>;
  readonly targetResidualOhm: number | null;
  readonly executableIdentity: Readonly<{ sha256: string; sizeBytes: number }>;
  readonly modelWarnings: readonly KicadTransmissionLineModelWarning[];
  readonly scope: string;
}
export interface KicadTransmissionLineCalculator {
  calculate(request: unknown): Promise<KicadTransmissionLineResult>;
}
const calculators = new WeakSet<object>();
/** Factory provenance for engineering row evaluators; caller-supplied functions are not pinned helpers. */
export function isKicadTransmissionLineCalculator(value: unknown): value is KicadTransmissionLineCalculator {
  return value !== null && typeof value === "object" && calculators.has(value);
}

// Evidence: pinned transline_calculation_base.cpp::UnitPropagationDelay and units.h::C0;
// https://qucs.sourceforge.net/tech/node77.html (coupled model envelope);
// independent scikit-rf 2.1.0 MLine comparison (different finite-thickness correction).
function modelWarnings(request: KicadTransmissionLineRequest, native: KicadTransmissionLineNativeResult): readonly KicadTransmissionLineModelWarning[] {
  const warnings: KicadTransmissionLineModelWarning[] = [{ code: "NATIVE_DELAY_APPROXIMATION",
    message: "Native UNIT_PROP_DELAY uses 2.99e8 m/s, while the native phase constant uses 299792458 m/s. For relative permeability 1 the reported native delay is approximately 0.265036% higher than the phase-derived delay. Native values are preserved; they are not phase-exact.",
    affectedResults: Object.keys(native.results).filter(key => key.startsWith("UNIT_PROP_DELAY")) }];
  if (request.model === "microstrip" && request.parameters.H_T === "absent") {
    warnings.push({ code: "MICROSTRIP_UNCOVERED_MODEL", message: "The metallic top cover is absent: the pinned single-microstrip cover filling multiplier uses its exact H_T/H → +infinity limit of 1. This uniform bare-conductor cross-section has air above the substrate; it does not model solder mask, arbitrary dielectric layers, nearby lateral copper, or board discontinuities.", affectedResults: ["Z0", "EPSILON_EFF"] });
  } else if (request.model === "microstrip" || request.model === "coupled_microstrip") {
    warnings.push({ code: "MICROSTRIP_METALLIC_COVER", message: "H_T represents a metallic cover, not solder mask. This cross-section does not represent arbitrary masked or multilayer dielectric structures.", affectedResults: ["Z0", "Z0_E", "Z0_O", "Z_DIFF"].filter(key => key in native.results) });
  }
  if (request.model === "microstrip") warnings.push({ code: "FINITE_THICKNESS_MODEL_VARIANT",
    message: "An independent MLine comparison uses a different finite-thickness correction. Thin-limit agreement does not establish an absolute accuracy bound for this pinned KiCad finite-thickness model.", affectedResults: ["Z0", "EPSILON_EFF"] });
  if (request.model === "coupled_stripline") {
    warnings.push({ code: "COUPLED_STRIPLINE_SOURCE_CORRECTIONS",
      message: "Implementation evleda-stripline-corrections-v1 differs from the preserved upstream core in two reviewed expressions: the isolated-stripline offset is (H-T)/2 instead of H/2, and the narrow-gap Eq.22 fringe/gap admittance terms include the dielectric factors required for homogeneous 1/sqrt(relative permittivity) impedance scaling. These algebraic corrections do not establish absolute physical accuracy.", affectedResults: ["Z0_E", "Z0_O", "Z_DIFF"] });
    warnings.push({ code: "COUPLED_STRIPLINE_PIECEWISE_INVERSE",
      message: "The native coupled-stripline approximation switches odd-mode formulas at edge spacing/conductor thickness S/T=5. The branch discontinuity remains after the corrections and can produce nonunique inverse geometries or failed synthesis. A met impedance target is not proof of unique geometry, physical accuracy, or manufacturing suitability.", affectedResults: ["PHYS_WIDTH", "PHYS_S", "Z0_O", "Z_DIFF"] });
  }
  if (request.model === "coupled_microstrip") {
    warnings.push({ code: "COUPLED_MICROSTRIP_DIFFERENTIAL_BASIS", message: "Native Z_DIFF uses quasistatic odd-mode impedance. The adapter separately reports twice frequency-dependent Z0_O; these values can differ and are not interchangeable.", affectedResults: ["Z_DIFF", "Z0_O"] });
    const p = request.parameters;
    const width = native.results.PHYS_WIDTH?.value ?? p.PHYS_WIDTH;
    const spacing = native.results.PHYS_S?.value ?? p.PHYS_S;
    if (width / p.H < 0.1 || width / p.H > 10 || spacing / p.H < 0.1 || spacing / p.H > 10
        || p.EPSILONR > 18 || p.FREQUENCY * p.H / 1e6 > 20) warnings.push({ code: "COUPLED_MICROSTRIP_MODEL_RANGE",
      message: "The evaluated geometry is outside the published Kirschning-Jansen coupled-microstrip impedance approximation envelope: W/H and S/H 0.1 to 10, relative permittivity 1 to 18, and frequency(GHz) times H(mm) at most 20. This envelope is not a fabrication tolerance; membership does not validate finite-thickness or metallic-cover corrections.", affectedResults: ["Z0_E", "Z0_O", "Z_DIFF"] });
  }
  return Object.freeze(warnings.map(warning => Object.freeze({ ...warning, affectedResults: Object.freeze([...warning.affectedResults]) })));
}

/** Pinned headless KiCad analytical calculator; does not bind or mutate a board. */
export async function createKicadTransmissionLineCalculator(options: KicadTransmissionLineOptions): Promise<KicadTransmissionLineCalculator> {
  const expected = Object.freeze({ ...options.expectedExecutableIdentity });
  if (!path.isAbsolute(options.executablePath) || !path.isAbsolute(options.cwd)
      || !/^[a-f0-9]{64}$/u.test(expected.sha256) || !Number.isSafeInteger(expected.sizeBytes)
      || expected.sizeBytes < 1 || expected.sizeBytes > 128 * 1024 * 1024) throw new Error("Transmission-line helper requires an exact host executable pin and absolute paths.");
  const command = options.executablePath;
  const cwd = await realpath(options.cwd);
  if (!(await lstat(cwd)).isDirectory()) throw new Error("Transmission-line helper cwd must be a directory.");
  const environment = Object.freeze({ ...options.environment });
  const runner = options.runner ?? runBoundedProcess;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error("Invalid transmission-line helper timeout.");
  async function assertPin() {
    const before = await lstat(command);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.sizeBytes) throw new Error("Transmission-line executable pin mismatch.");
    const bytes = await readFile(command);
    const after = await lstat(command);
    if (contentIdentity(bytes).digest !== expected.sha256 || bytes.length !== expected.sizeBytes
        || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs
        || before.size !== after.size || !after.isFile() || after.isSymbolicLink()) throw new Error("Transmission-line executable pin mismatch or drift.");
  }
  await assertPin();
  const calculator = Object.freeze({ calculate: async (input: unknown): Promise<KicadTransmissionLineResult> => {
    const request = kicadTransmissionLineRequestSchema.parse(input);
    const coupled = request.model.startsWith("coupled_");
    const parameters: Record<string, number | "absent"> = { ...request.parameters };
    if (request.operation === "synthesize") parameters[coupled ? "Z0_O" : "Z0"] = request.targetOhm / (coupled ? 2 : 1);
    const args = ["--model", request.model, "--operation", request.operation,
      ...("fixed" in request ? ["--fix", request.fixed] : []),
      ...Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`)];
    await assertPin();
    const process = await runner({ command, args, cwd, env: environment, timeoutMs, maxOutputBytes: 64 * 1024,
      ...(options.windowsProcessTreeTermination === undefined ? {} : { windowsProcessTreeTermination: options.windowsProcessTreeTermination }) });
    await assertPin();
    if (process.exitCode !== 0 && process.exitCode !== 2) throw new Error(`Transmission-line helper failed with exit code ${process.exitCode}: ${process.stderr.slice(0, 2000)}`);
    const native = nativeResponseSchema.parse(parsePortableJsonBytes(Buffer.from(process.stdout), { maxBytes: 64 * 1024, maxDepth: 8, maxNodes: 2000 }));
    if (request.model === "microstrip" && request.parameters.H_T === "absent"
        && native.schemaVersion !== KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION) throw new Error("Absent metallic cover requires the qualified protocol-3 transmission-line helper.");
    const echoed = Object.fromEntries(Object.entries(parameters).map(([name, value]) => [name, { value, unit: value === "absent" ? "1" : unit(name) }]));
    if (native.model !== request.model || native.operation !== request.operation || canonicalJson(native.inputs) !== canonicalJson(echoed)) throw new Error("Transmission-line helper response does not match the requested inputs.");
    for (const [name, result] of Object.entries(native.results)) {
      if (!(names as readonly string[]).includes(name) || result.unit !== unit(name)
          || result.value === null && result.status !== "error") throw new Error("Transmission-line helper returned an unsupported result or incorrect unit/status.");
    }
    for (const name of ["PHYS_WIDTH", "PHYS_LEN", ...(coupled ? ["PHYS_S", "Z0_O", "Z0_E", "Z_DIFF"] : ["Z0"])]) {
      if (native.results[name] === undefined) throw new Error(`Transmission-line helper omitted required result ${name}.`);
    }
    const singleEndedOhm = coupled ? null : native.results.Z0!.value;
    const oddModeOhm = coupled ? native.results.Z0_O!.value : null;
    const differentialAtFrequencyOhm = oddModeOhm === null ? null : 2 * oddModeOhm;
    const actual = coupled ? differentialAtFrequencyOhm : singleEndedOhm;
    const residual = request.operation === "synthesize" && actual !== null ? actual - request.targetOhm : null;
    const badResults = Object.values(native.results).some(result => result.status === "error" || result.value === null);
    const missed = residual !== null && Math.abs(residual) > (coupled ? 2e-4 : 1e-4);
    if (native.valid && (!native.converged || badResults || missed || actual === null || !Number.isFinite(actual) || actual <= 0)
        || native.valid !== (process.exitCode === 0)) throw new Error("Transmission-line helper validity contradicts its calculated results or process outcome.");
    const status = !native.converged ? "not_converged" : badResults ? "invalid_model_result" : missed ? "target_not_reached" : native.valid ? "calculated" : "invalid_model_result";
    return Object.freeze({ status, request, native,
      impedance: Object.freeze({ singleEndedOhm, oddModeOhm, differentialAtFrequencyOhm,
        nativeDifferentialOhm: coupled ? native.results.Z_DIFF!.value : null,
        nativeDifferentialBasis: !coupled ? "not-applicable" as const : request.model === "coupled_microstrip" ? "quasistatic" as const : "native-coupled-stripline" as const }),
      targetResidualOhm: residual, executableIdentity: expected, modelWarnings: modelWarnings(request, native),
      scope: `Pinned KiCad 10.0.3 analytical core, implementation ${native.implementationRevision}, with the retained evleda-stripline-corrections-v1 changes${native.schemaVersion === 3 ? " and explicit uncovered single-microstrip support" : ""}, for the supplied uniform cross-section and material inputs; not a field solver, board validation, or independently qualified absolute prediction. Native warnings remain applicable. To assess manufacturing rounding, submit the rounded geometry in a separate analyze request.` });
  } });
  calculators.add(calculator);
  return calculator;
}

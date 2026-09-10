import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { assessSavedMicrostrip, savedMicrostripRequestSchema } from "../../src/harness/saved-microstrip-assessment.js";
import {
  createKicadTransmissionLineCalculator,
  KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION,
  KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION,
  KICAD_TRANSMISSION_LINE_SOURCE_COMMIT,
  type KicadTransmissionLineCalculator,
} from "../../src/integrations/kicad-transmission-line.js";
import type { BoundedProcessOptions, BoundedProcessResult } from "../../src/integrations/bounded-process.js";

const ownedDirectories: string[] = [];
afterEach(async () => {
  for (const directory of ownedDirectories.splice(0)) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) throw new Error("Unsafe fixture cleanup");
    await rm(resolved, { recursive: true, force: true });
  }
});

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const referenceZoneUuid = id(101);
const copper = (layer: string) => `(layer "${layer}" (type "copper") (thickness 0.035))`;
const dielectric = `(layer "dielectric 1" (type "core") (thickness 0.2)
  (material "FR4") (epsilon_r 4.2) (loss_tangent 0.02))`;
const topMask = `(layer "F.Mask" (type "Top Solder Mask") (thickness 0))`;
const baseStackup = `${topMask} ${copper("F.Cu")} ${dielectric} ${copper("B.Cu")}`;
const pad = (uuid: number, net = "SIG", extra = "") => `(pad "1" smd rect (at 0 0) (size 1 1)
  (layers "F.Cu" "F.Paste" "F.Mask") (net "${net}") (uuid "${id(uuid)}") ${extra})`;
const footprint = (reference: string, uuid: number, x: number, y: number, pads = pad(uuid + 1), rotation = 0) =>
  `(footprint "Fixture:Terminal" (layer "F.Cu") (at ${x} ${y} ${rotation})
    (uuid "${id(uuid)}") (property "Reference" "${reference}") ${pads})`;
const terminals = `${footprint("J1", 11, 0, 0)} ${footprint("J2", 21, 10, 0)}`;
const segment = (uuid: number, start: string, end: string, width = "0.3", layer = "F.Cu", net = "SIG") =>
  `(segment (start ${start}) (end ${end}) (width ${width}) (layer "${layer}") (net "${net}") (uuid "${id(uuid)}"))`;
const route = `${segment(1, "0 0", "4 0")} ${segment(2, "4 0", "10 0")}`;
const zone = (net = "GND", layer = "B.Cu", uuid = referenceZoneUuid) => `(zone (net "${net}")
  (layer "${layer}") (uuid "${uuid}") (connect_pads yes (clearance 0.3)) (min_thickness 0.25)
  (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
  (polygon (pts (xy -2 -2) (xy 12 -2) (xy 12 2) (xy -2 2))))`;
interface BoardOptions {
  readonly stackup?: string;
  readonly innerLayers?: string;
  readonly footprints?: string;
  readonly tracks?: string;
  readonly reference?: string;
  readonly extra?: string;
}
const pcb = (options: BoardOptions = {}) => `(kicad_pcb (version 20260206)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) ${options.innerLayers ?? ""} (2 "B.Cu" signal)
    (1 "F.Mask" user) (3 "B.Mask" user) (13 "F.Paste" user) (15 "B.Paste" user))
  (setup (stackup ${options.stackup ?? baseStackup}))
  ${options.footprints ?? terminals} ${options.tracks ?? route} ${options.reference ?? zone()} ${options.extra ?? ""})`;

const requestFor = (source: string | Uint8Array) => ({
  expectedSourceIdentity: contentIdentity(source),
  net: "SIG",
  signalLayer: "F.Cu" as const,
  reference: { net: "GND", layer: "B.Cu", zoneUuid: referenceZoneUuid },
  terminals: [{ reference: "J1", pad: "1" }, { reference: "J2", pad: "1" }],
  targetOhm: 56.5,
  absoluteToleranceOhm: 0.25,
  frequencyHz: 1e9,
  construction: {
    topCover: "absent" as const,
    surface: "bare" as const,
    dielectric: { material: "FR4", epsilonR: 4.2, lossTangent: 0.02, frequencyHz: 1e9,
      evidence: "Caller supplied test material declaration at the analysis frequency" },
    conductor: { conductivitySiemensPerMetre: 5.8e7, relativePermeability: 1, roughnessNm: 0,
      evidence: "Caller supplied test copper declaration" },
    substrateRelativePermeability: 1,
    evidence: "Fixture construction declaration; no manufacturing qualification" },
});

const exteriorLayers = [
  { name: "F.Paste", type: "Top Solder Paste" }, { name: "F.SilkS", type: "Top Silk Screen" },
  { name: "B.Paste", type: "Bottom Solder Paste" }, { name: "B.SilkS", type: "Bottom Silk Screen" },
];
function exteriorFixture(name: string, typeField: string, thicknessField: string) {
  const exterior = `(layer "${name}" ${typeField} ${thicknessField})`;
  const front = name.startsWith("F.");
  const source = front ? pcb({ stackup: `${exterior} ${baseStackup}` }) : pcb({
    stackup: `${copper("F.Cu")} ${dielectric} ${copper("B.Cu")}
      (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0)) ${exterior}`,
    footprints: terminals.replaceAll('"F.Cu"', '"B.Cu"').replaceAll('"F.Paste"', '"B.Paste"').replaceAll('"F.Mask"', '"B.Mask"'),
    tracks: route.replaceAll('"F.Cu"', '"B.Cu"'), reference: zone("GND", "F.Cu"),
  });
  const request = requestFor(source);
  return { source, request: front ? request : { ...request, signalLayer: "B.Cu", reference: { ...request.reference, layer: "F.Cu" } } };
}

function parameterUnit(name: string) {
  if (["H", "T", "PHYS_WIDTH", "PHYS_LEN", "H_T", "ROUGH"].includes(name)) return "m";
  return name === "FREQUENCY" ? "Hz" : name === "SIGMA" ? "S/m" : "1";
}

/** Factory pinning is real; the host runner seam never executes this fixture file. */
async function calculatorFixture(ohm = 56.5, onDispatch?: () => void | Promise<void>, converged = true) {
  const cwd = await mkdtemp(path.join(tmpdir(), "evleda-saved-microstrip-"));
  ownedDirectories.push(cwd);
  const executablePath = path.join(cwd, "fixture.exe");
  const bytes = Buffer.from("Pinned saved-microstrip unit fixture only; never executable code");
  await writeFile(executablePath, bytes);
  const runner = vi.fn(async (options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    await onDispatch?.();
    const inputs = Object.fromEntries(options.args.filter(arg => arg.includes("=")).map(arg => {
      const [name, value] = arg.split("=");
      return [name!, value === "absent" ? { value: "absent", unit: "1" }
        : { value: Number(value), unit: parameterUnit(name!) }];
    }));
    return { command: options.command, args: options.args, cwd: options.cwd, exitCode: converged ? 0 : 2,
      stdout: JSON.stringify({ schemaVersion: KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION,
        implementationRevision: KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION,
        sourceCommit: KICAD_TRANSMISSION_LINE_SOURCE_COMMIT, model: "microstrip", operation: "analyze",
        converged, valid: converged, inputs, results: {
          PHYS_WIDTH: { ...inputs.PHYS_WIDTH, status: "ok" },
          PHYS_LEN: { ...inputs.PHYS_LEN, status: "ok" },
          Z0: { value: ohm, unit: "ohm", status: "ok" },
        } }), stderr: "", durationMs: 1, startedAt: "2026-09-10T00:00:00Z" };
  });
  const calculator = await createKicadTransmissionLineCalculator({ executablePath, cwd, environment: {},
    expectedExecutableIdentity: { sha256: contentIdentity(bytes).digest, sizeBytes: bytes.length }, runner });
  return { calculator, runner };
}

describe("saved-source uncovered single-microstrip assessment", () => {
  it("binds exact source and request identities and derives the model geometry from saved source", async () => {
    const source = pcb(), request = requestFor(source), f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator });
    expect(result.sourceIdentity).toEqual(contentIdentity(source));
    expect(result.request).toEqual(request);
    expect(result.requestIdentity).toEqual(canonicalIdentity(request, "evleda.saved-microstrip-request.v1"));
    expect(result.routeCompleteness).toMatchObject({ status: "complete_source_chain", widthNm: 300000, totalLengthNm: 10000000 });
    expect(result.routeCompleteness.segments).toHaveLength(2);
    expect(result.routeCompleteness.terminalAnchors).toHaveLength(2);
    expect(result.construction).toMatchObject({ status: "supported_source_declaration", dielectricThicknessNm: 200000,
      signalCopperThicknessNm: 35000, referenceCopperThicknessNm: 35000 });
    expect(result.constructionProvenance.authority).toBe("caller_asserted_metadata");
    expect(result.modelApplicability.status).toBe("conditional_model_only");
    expect(result.numericalTarget).toMatchObject({ status: "within_tolerance", calculatedOhm: 56.5 });
    expect(result.referenceRequirements).toMatchObject({ status: "unassessed", declarationStatus: "matched_saved_zone" });
    expect(result.boardAccepted).toBe(false);
    expect(result.interfaceAccepted).toBe(false);
    expect(f.runner).toHaveBeenCalledTimes(1);
    const args = f.runner.mock.calls[0]![0].args;
    expect(args).toEqual(expect.arrayContaining(["--model", "microstrip", "--operation", "analyze",
      "H=0.0002", "T=0.000035", "H_T=absent", "PHYS_WIDTH=0.0003", "PHYS_LEN=0.01",
      "EPSILONR=4.2", "TAND=0.02", "FREQUENCY=1000000000", "SIGMA=58000000", "MUR=1", "MURC=1", "ROUGH=0"]));
    expect(args).not.toContain("H=0.0016");
    expect(result.modelWarnings.map(warning => warning.code)).toEqual(expect.arrayContaining([
      "MICROSTRIP_UNCOVERED_MODEL", "FINITE_THICKNESS_MODEL_VARIANT", "NATIVE_DELAY_APPROXIMATION",
    ]));
    const baseline = await f.calculator.calculate({ model: "microstrip", operation: "analyze", parameters: {
      H: 0.0002, T: 0.000035, H_T: "absent", PHYS_WIDTH: 0.0003, PHYS_LEN: 0.01,
      EPSILONR: 4.2, TAND: 0.02, FREQUENCY: 1e9, SIGMA: 5.8e7, MUR: 1, MURC: 1, ROUGH: 0,
    } });
    expect(result.modelWarnings).toEqual(baseline.modelWarnings);
  });

  it("retains the pre-await source and request snapshot when caller-owned inputs mutate during calculation", async () => {
    const savedPcbBytes = Buffer.from(pcb());
    const expectedIdentity = contentIdentity(savedPcbBytes), request = requestFor(savedPcbBytes);
    const expectedRequest = structuredClone(request);
    const release = Promise.withResolvers<void>();
    const f = await calculatorFixture(56.5, () => release.promise);
    const pending = assessSavedMicrostrip({ savedPcbBytes, request, calculator: f.calculator });
    // No await is allowed between the public call and mutation: snapshotting must
    // finish before the public call first yields, even if helper dispatch is later.
    savedPcbBytes.fill(0);
    request.net = "OTHER";
    request.targetOhm = 500;
    request.reference.net = "OTHER";
    request.construction.dielectric.epsilonR = 99;
    request.terminals[0]!.reference = "UNRELATED";
    release.resolve();
    const result = await pending;
    expect(contentIdentity(savedPcbBytes)).not.toEqual(expectedIdentity);
    expect(result.sourceIdentity).toEqual(expectedIdentity);
    expect(result.request).toEqual(expectedRequest);
    expect(result.requestIdentity).toEqual(canonicalIdentity(expectedRequest, "evleda.saved-microstrip-request.v1"));
    expect(result.routeCompleteness).toMatchObject({ status: "complete_source_chain", totalLengthNm: 10000000 });
    expect(result.numericalTarget).toMatchObject({ status: "within_tolerance", calculatedOhm: 56.5 });
  });

  it("binds only the selected Uint8Array byte view, excluding surrounding storage", async () => {
    const source = pcb(), sourceBytes = Buffer.from(source);
    const storage = new Uint8Array(sourceBytes.length + 20);
    storage.fill(120);
    storage.set(sourceBytes, 10);
    const savedPcbBytes = storage.subarray(10, sourceBytes.length + 10);
    const f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes, request: requestFor(source), calculator: f.calculator });
    expect(result.sourceIdentity).toEqual(contentIdentity(source));
    expect(result.numericalTarget.status).toBe("within_tolerance");
  });

  it("reads the caller's saved-byte accessor exactly once before snapshotting", async () => {
    const source = pcb(), bytes = Buffer.from(source), f = await calculatorFixture();
    let reads = 0;
    const result = await assessSavedMicrostrip({
      get savedPcbBytes() {
        if (++reads !== 1) throw new Error("Caller-owned saved-byte accessor was read twice");
        return bytes;
      },
      request: requestFor(source), calculator: f.calculator,
    });
    expect(reads).toBe(1);
    expect(result.sourceIdentity).toEqual(contentIdentity(source));
    expect(result.numericalTarget.status).toBe("within_tolerance");
  });

  it("derives the adjacent inward dielectric for a bottom-layer signal", async () => {
    const source = pcb({ stackup: `${copper("F.Cu")} ${dielectric} ${copper("B.Cu")}
      ${topMask.replaceAll("F.Mask", "B.Mask").replace("Top Solder Mask", "Bottom Solder Mask")}`,
    footprints: terminals.replaceAll('"F.Cu"', '"B.Cu"').replaceAll('"F.Paste"', '"B.Paste"').replaceAll('"F.Mask"', '"B.Mask"'),
    tracks: route.replaceAll('"F.Cu"', '"B.Cu"'), reference: zone("GND", "F.Cu") });
    const request = { ...requestFor(source), signalLayer: "B.Cu", reference: { net: "GND", layer: "F.Cu", zoneUuid: referenceZoneUuid } };
    const f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("complete_source_chain");
    expect(result.construction).toMatchObject({ status: "supported_source_declaration", dielectricThicknessNm: 200000 });
    expect(result.numericalTarget.status).toBe("within_tolerance");
  });

  it("adds complete identical dielectric sublayers without averaging different materials", async () => {
    const source = pcb({ stackup: baseStackup.replace(dielectric,
      '(layer "dielectric 1" (type "core") (thickness 0.1) (material "FR4") (epsilon_r 4.2) (loss_tangent 0.02) addsublayer (thickness 0.1) (material "FR4") (epsilon_r 4.2) (loss_tangent 0.02))') });
    const f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.construction).toMatchObject({ status: "supported_source_declaration", dielectricThicknessNm: 200000 });
    expect(f.runner.mock.calls[0]![0].args).toContain("H=0.0002");
  });

  it("uses the length of the complete bent chain and does not include another net's tracks", async () => {
    const source = pcb({ tracks: `${segment(1, "0 0", "3 4")} ${segment(2, "3 4", "6 4")}
      ${segment(3, "20 20", "21 20", "0.8", "B.Cu", "OTHER")}`,
    footprints: `${footprint("J1", 11, 0, 0)} ${footprint("J2", 21, 6, 4)}` });
    const f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness).toMatchObject({ status: "complete_source_chain", widthNm: 300000, totalLengthNm: 8000000 });
    expect(result.routeCompleteness.segments).toHaveLength(2);
    expect(f.runner.mock.calls[0]![0].args).toContain("PHYS_LEN=0.008");
  });

  it("changes the request identity for a different target on identical source", async () => {
    const source = pcb(), request = requestFor(source);
    const first = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request });
    const second = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: { ...request, targetOhm: 50 } });
    expect(first.sourceIdentity).toEqual(second.sourceIdentity);
    expect(first.requestIdentity).not.toEqual(second.requestIdentity);
  });

  it.each(["digest", "size"] as const)("rejects a mismatched source %s before calculation", async field => {
    const source = pcb(), request = requestFor(source), f = await calculatorFixture();
    request.expectedSourceIdentity = field === "digest"
      ? { ...request.expectedSourceIdentity, digest: "0".repeat(64) }
      : { ...request.expectedSourceIdentity, size: request.expectedSourceIdentity.size + 1 };
    await expect(assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator })).rejects.toThrow();
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([{ ohm: 56.25, status: "within_tolerance" }, { ohm: 56.75, status: "within_tolerance" },
    { ohm: 56.7501, status: "outside_tolerance" }, { ohm: 56.2499, status: "outside_tolerance" }])(
    "reports $ohm ohm as $status without accepting the board", async ({ ohm, status }) => {
      const source = pcb(), f = await calculatorFixture(ohm);
      const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
      expect(result.numericalTarget).toMatchObject({ status, calculatedOhm: ohm });
      expect(result.referenceRequirements.status).toBe("unassessed");
      expect(result.boardAccepted).toBe(false);
      expect(result.interfaceAccepted).toBe(false);
    });

  it("keeps a source-complete model numerically unassessed without a pinned calculator", async () => {
    const source = pcb();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source) });
    expect(result.routeCompleteness.status).toBe("complete_source_chain");
    expect(result.construction.status).toBe("supported_source_declaration");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(result.boardAccepted).toBe(false);
  });

  it("does not compare a non-converged genuine helper result against the target", async () => {
    const source = pcb(), f = await calculatorFixture(56.5, undefined, false);
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(result.boardAccepted).toBe(false);
    expect(result.interfaceAccepted).toBe(false);
    const baseline = await f.calculator.calculate({ model: "microstrip", operation: "analyze", parameters: {
      H: 0.0002, T: 0.000035, H_T: "absent", PHYS_WIDTH: 0.0003, PHYS_LEN: 0.01,
      EPSILONR: 4.2, TAND: 0.02, FREQUENCY: 1e9, SIGMA: 5.8e7, MUR: 1, MURC: 1, ROUGH: 0,
    } });
    expect(baseline.status).toBe("not_converged");
    expect(result.numericalTarget.calculation).toEqual(baseline);
    expect(result.modelWarnings).toEqual(baseline.modelWarnings);
  });

  it("refuses a structural calculator impostor without invoking it", async () => {
    const source = pcb();
    const calculate = vi.fn(async () => { throw new Error("Unbranded calculator must never run"); });
    const calculator = { calculate } as KicadTransmissionLineCalculator;
    await expect(assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator })).rejects.toThrow();
    expect(calculate).not.toHaveBeenCalled();
  });

  it("checks calculator provenance without reading a caller-controlled calculate property", async () => {
    const source = pcb();
    const readCalculate = vi.fn(() => { throw new Error("Untrusted accessor must not run"); });
    const calculator = Object.defineProperty({}, "calculate", { get: readCalculate }) as KicadTransmissionLineCalculator;
    await expect(assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator })).rejects.toThrow();
    expect(readCalculate).not.toHaveBeenCalled();
  });

  it("validates strict caller input before dispatching the genuine host calculator", async () => {
    const source = pcb(), f = await calculatorFixture();
    const request = { ...requestFor(source), boardAccepted: true };
    await expect(assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator })).rejects.toThrow();
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([
    { name: "positive top mask", stackup: baseStackup.replace(topMask, topMask.replace("(thickness 0)", "(thickness 0.01)")) },
    { name: "omitted top mask", stackup: baseStackup.replace(topMask, "") },
    { name: "missing mask thickness", stackup: baseStackup.replace(topMask, topMask.replace("(thickness 0)", "")) },
    { name: "missing mask type", stackup: baseStackup.replace(topMask, topMask.replace('(type "Top Solder Mask")', "")) },
    { name: "contradictory mask type", stackup: baseStackup.replace(topMask, topMask.replace('(type "Top Solder Mask")', '(type "copper")')) },
    { name: "opposite-side mask type", stackup: baseStackup.replace(topMask, topMask.replace("Top Solder Mask", "Bottom Solder Mask")) },
    { name: "exterior dielectric above the zero-thickness mask", stackup: `${dielectric.replace("dielectric 1", "dielectric 2")} ${baseStackup}` },
    { name: "nonzero exterior paste", stackup: `(layer "F.Paste" (type "Top Solder Paste") (thickness 0.02)) ${baseStackup}` },
    { name: "nonzero exterior silkscreen", stackup: `(layer "F.SilkS" (type "Top Silk Screen") (thickness 0.02)) ${baseStackup}` },
    { name: "explicit non-bare ENIG finish", stackup: `${baseStackup} (copper_finish "ENIG")` },
    { name: "missing dielectric thickness", stackup: baseStackup.replace("(thickness 0.2)", "") },
    { name: "missing dielectric loss tangent", stackup: baseStackup.replace("(loss_tangent 0.02)", "") },
    { name: "missing dielectric permittivity", stackup: baseStackup.replace("(epsilon_r 4.2)", "") },
    { name: "missing dielectric material", stackup: baseStackup.replace('(material "FR4")', "") },
    { name: "missing signal copper thickness", stackup: baseStackup.replace(copper("F.Cu"), '(layer "F.Cu" (type "copper"))') },
    { name: "zero signal copper thickness", stackup: baseStackup.replace(copper("F.Cu"), copper("F.Cu").replace("0.035", "0")) },
    { name: "missing reference copper thickness", stackup: baseStackup.replace(copper("B.Cu"), '(layer "B.Cu" (type "copper"))') },
    { name: "sub-nm dielectric thickness", stackup: baseStackup.replace("(thickness 0.2)", "(thickness 0.2000001)") },
    { name: "sub-nm dielectric thickness hidden by binary64 projection", stackup: baseStackup.replace("(thickness 0.2)", "(thickness 0.20000000000000001)") },
    { name: "sub-nm copper thickness hidden by binary64 projection", stackup: baseStackup.replace("(thickness 0.035)", "(thickness 0.03500000000000000001)") },
    { name: "heterogeneous dielectric sublayers", stackup: baseStackup.replace(dielectric,
      '(layer "dielectric 1" (type "core") (thickness 0.1) (material "FR4") (epsilon_r 4.2) (loss_tangent 0.02) addsublayer (thickness 0.1) (material "FR4") (epsilon_r 4.8) (loss_tangent 0.02))') },
  ])("leaves $name unassessed despite the caller's bare-surface assertion", async ({ stackup }) => {
    const source = pcb({ stackup }), f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("complete_source_chain");
    expect(result.construction.status).toBe("unassessed");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each(exteriorLayers.flatMap(layer => ["missing", "wrong"].flatMap(typeCase => ["missing", "zero"].map(thicknessCase =>
    ({ ...layer, typeCase, thicknessCase })))))(
    "rejects outward $name with $typeCase type and $thicknessCase thickness", async ({ name, typeCase, thicknessCase }) => {
      const { source, request } = exteriorFixture(name, typeCase === "missing" ? "" : '(type "copper")',
        thicknessCase === "missing" ? "" : "(thickness 0)");
      const f = await calculatorFixture();
      const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator });
      expect(result.routeCompleteness.status).toBe("complete_source_chain");
      expect(result.construction.status).toBe("unassessed");
      expect(result.numericalTarget.status).toBe("unassessed");
      expect(f.runner).not.toHaveBeenCalled();
    });

  it.each(exteriorLayers.flatMap(layer => ["missing", "zero"].map(thicknessCase => ({ ...layer, thicknessCase }))))(
    "supports outward $name with its matching type and $thicknessCase thickness", async ({ name, type, thicknessCase }) => {
      const { source, request } = exteriorFixture(name, `(type "${type}")`, thicknessCase === "missing" ? "" : "(thickness 0)");
      const f = await calculatorFixture();
      const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator });
      expect(result.routeCompleteness.status).toBe("complete_source_chain");
      expect(result.construction.status).toBe("supported_source_declaration");
      expect(result.numericalTarget.status).toBe("within_tolerance");
      expect(f.runner).toHaveBeenCalledTimes(1);
    });

  it("does not skip intervening copper when selecting a reference plane", async () => {
    const source = pcb({ innerLayers: '(4 "In1.Cu" signal)', stackup:
      `${topMask} ${copper("F.Cu")} ${dielectric} ${copper("In1.Cu")}
        ${dielectric.replace("dielectric 1", "dielectric 2")} ${copper("B.Cu")}` });
    const f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.construction.status).toBe("unassessed");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each(["material", "epsilonR", "lossTangent"] as const)(
    "does not substitute asserted dielectric %s for differing source evidence", async field => {
      const source = pcb(), request = requestFor(source), f = await calculatorFixture();
      if (field === "material") request.construction.dielectric.material = "OTHER";
      else request.construction.dielectric[field] *= 2;
      const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator });
      expect(result.construction.status).toBe("unassessed");
      expect(result.numericalTarget.status).toBe("unassessed");
      expect(f.runner).not.toHaveBeenCalled();
    });

  it("rejects a dielectric assertion at a different frequency before helper dispatch", async () => {
    const source = pcb(), request = requestFor(source), f = await calculatorFixture();
    request.construction.dielectric.frequencyHz *= 2;
    expect(savedMicrostripRequestSchema.safeParse(request).success).toBe(false);
    await expect(assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator })).rejects.toThrow();
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([
    { name: "relative permittivity above 18", epsilonR: 19, width: "0.3", frequencyHz: 1e9, substrateMUR: 1 },
    { name: "width-to-height ratio below 0.1", epsilonR: 4.2, width: "0.019", frequencyHz: 1e9, substrateMUR: 1 },
    { name: "width-to-height ratio above 10", epsilonR: 4.2, width: "2.000001", frequencyHz: 1e9, substrateMUR: 1 },
    { name: "normalized frequency fH/c above 0.1", epsilonR: 4.2, width: "0.3", frequencyHz: 2e11, substrateMUR: 1 },
    { name: "magnetic substrate", epsilonR: 4.2, width: "0.3", frequencyHz: 1e9, substrateMUR: 2 },
  ])("keeps the numerical model unassessed for $name", async ({ epsilonR, width, frequencyHz, substrateMUR }) => {
    const source = pcb({ stackup: baseStackup.replace("(epsilon_r 4.2)", `(epsilon_r ${epsilonR})`),
      tracks: `${segment(1, "0 0", "4 0", width)} ${segment(2, "4 0", "10 0", width)}` });
    const request = requestFor(source), f = await calculatorFixture();
    request.frequencyHz = frequencyHz;
    request.construction.dielectric.frequencyHz = frequencyHz;
    request.construction.dielectric.epsilonR = epsilonR;
    request.construction.substrateRelativePermeability = substrateMUR;
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("complete_source_chain");
    expect(result.construction.status).toBe("supported_source_declaration");
    expect(result.modelApplicability.status).toBe("unassessed");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([
    { name: "maximum relative permittivity", epsilonR: 18, width: "0.3" },
    { name: "minimum width-to-height ratio", epsilonR: 4.2, width: "0.02" },
    { name: "maximum width-to-height ratio", epsilonR: 4.2, width: "2.0" },
  ])("retains the inclusive model boundary at $name", async ({ epsilonR, width }) => {
    const source = pcb({ stackup: baseStackup.replace("(epsilon_r 4.2)", `(epsilon_r ${epsilonR})`),
      tracks: `${segment(1, "0 0", "4 0", width)} ${segment(2, "4 0", "10 0", width)}` });
    const request = requestFor(source), f = await calculatorFixture();
    request.construction.dielectric.epsilonR = epsilonR;
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request, calculator: f.calculator });
    expect(result.modelApplicability.status).toBe("conditional_model_only");
    expect(result.numericalTarget.status).toBe("within_tolerance");
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it("does not exclude an otherwise supported board for a separately inventoried other-net through-via", async () => {
    const source = pcb({ tracks: `${route}
      (via (at 20 20) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "OTHER") (uuid "${id(3)}"))` });
    const f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness).toMatchObject({ status: "complete_source_chain", totalLengthNm: 10000000 });
    expect(result.routeCompleteness.segments).toHaveLength(2);
    expect(result.numericalTarget.status).toBe("within_tolerance");
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect(result.boardAccepted).toBe(false);
  });

  it.each([
    { name: "duplicate net fields", via: `(via (at 20 20) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "OTHER") (net "SIG") (uuid "${id(3)}"))` },
    { name: "sub-nm coordinates", via: `(via (at 20.0000001 20) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "OTHER") (uuid "${id(3)}"))` },
    { name: "nonpositive diameter", via: `(via (at 20 20) (size 0) (drill 0.3) (layers "F.Cu" "B.Cu") (net "OTHER") (uuid "${id(3)}"))` },
    { name: "drill at least the diameter", via: `(via (at 20 20) (size 0.6) (drill 0.6) (layers "F.Cu" "B.Cu") (net "OTHER") (uuid "${id(3)}"))` },
    { name: "reversed copper layer tuple", via: `(via (at 20 20) (size 0.6) (drill 0.3) (layers "B.Cu" "F.Cu") (net "OTHER") (uuid "${id(3)}"))` },
    { name: "unknown modifier", via: `(via (at 20 20) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "OTHER") (uuid "${id(3)}") (future 1))` },
  ])("does not hide an other-net via with $name", async ({ via }) => {
    const source = pcb({ tracks: `${route} ${via}` }), f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("unassessed");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([
    { name: "wrong-layer selected-net track", tracks: `${segment(1, "0 0", "4 0")} ${segment(2, "4 0", "10 0", "0.3", "B.Cu")}` },
    { name: "mixed widths", tracks: `${segment(1, "0 0", "4 0")} ${segment(2, "4 0", "10 0", "0.31")}` },
    { name: "branch", tracks: `${route} ${segment(3, "4 0", "4 2")}` },
    { name: "disconnected remainder", tracks: `${segment(1, "0 0", "4 0")} ${segment(2, "5 0", "10 0")}` },
    { name: "cycle", tracks: `${route} ${segment(3, "10 0", "5 3")} ${segment(4, "5 3", "0 0")}` },
    { name: "duplicate overlapping route", tracks: `${route} ${segment(3, "0 0", "4 0")}` },
    { name: "partial collinear overlap", tracks: `${segment(1, "0 0", "6 0")} ${segment(2, "4 0", "10 0")}` },
    { name: "graph-simple collinear backtracking", tracks: `${segment(1, "0 0", "6 0")} ${segment(2, "6 0", "4 0")} ${segment(3, "4 0", "10 0")}` },
    { name: "interior self crossing", tracks: `${segment(1, "0 0", "10 10")} ${segment(2, "10 10", "0 10")} ${segment(3, "0 10", "10 0")}` },
    { name: "zero width", tracks: segment(1, "0 0", "10 0", "0") },
    { name: "sub-nm width", tracks: segment(1, "0 0", "10 0", "0.3000001") },
    { name: "sub-nm endpoint", tracks: segment(1, "0 0", "10.0000001 0") },
    { name: "no selected route", tracks: segment(1, "0 0", "10 0", "0.3", "F.Cu", "OTHER") },
    { name: "selected-net via", tracks: `${route} (via (at 4 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "${id(3)}"))` },
    { name: "selected-net arc", tracks: `${route} (arc (start 0 0) (mid 5 5) (end 10 0) (width 0.3) (layer "F.Cu") (net "SIG") (uuid "${id(3)}"))` },
  ])("does not assess a complete source chain with $name", async ({ tracks }) => {
    const source = pcb({ tracks }), f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("unassessed");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing terminal", footprints: footprint("J1", 11, 0, 0) },
    { name: "extra selected-net pad", footprints: `${terminals} ${footprint("J3", 31, 4, 0)}` },
    { name: "wrong terminal net", footprints: `${footprint("J1", 11, 0, 0)} ${footprint("J2", 21, 10, 0, pad(22, "OTHER"))}` },
    { name: "wrong pad number", footprints: terminals.replace('(pad "1"', '(pad "2"') },
    { name: "endpoint away from pad center", footprints: `${footprint("J1", 11, 0, 0)} ${footprint("J2", 21, 10.1, 0)}` },
    { name: "duplicate footprint reference", footprints: `${terminals} ${footprint("J1", 31, 2, 0, pad(32, "OTHER"))}` },
    { name: "through-hole terminal", footprints: terminals.replace('smd rect', 'thru_hole circle').replace('(size 1 1)', '(size 1 1) (drill 0.5)') },
    { name: "non-cardinal footprint placement", footprints: `${footprint("J1", 11, 0, 0, pad(12), 45)} ${footprint("J2", 21, 10, 0)}` },
    { name: "malformed third pad with duplicated selected-net fields", footprints: `${terminals}
      ${footprint("J3", 31, 4, 0, pad(32, "SIG", '(net "SIG")'))}` },
    { name: "same terminal selector repeated on another net", footprints:
      `${footprint("J1", 11, 0, 0, `${pad(12)} ${pad(13, "OTHER")}`)} ${footprint("J2", 21, 10, 0)}` },
    { name: "pad nested under an unknown footprint field", footprints:
      `${terminals} ${footprint("J3", 31, 4, 0, `(future ${pad(32)})`)}` },
    { name: "pad nested under a scalar footprint field", footprints:
      `${terminals} ${footprint("J3", 31, 4, 0, "").replace('(property "Reference" "J3")', `(property "Reference" "J3" ${pad(32)})`)}` },
    { name: "footprint nested under an unknown footprint field", footprints:
      `${footprint("J1", 11, 0, 0, `${pad(12)} (future ${footprint("J3", 31, 4, 0)})`)} ${footprint("J2", 21, 10, 0)}` },
    { name: "footprint nested under a scalar pad field", footprints:
      `${footprint("J1", 11, 0, 0, pad(12, "SIG", `(pinfunction "A" ${footprint("J3", 31, 4, 0)})`))} ${footprint("J2", 21, 10, 0)}` },
    { name: "pad nested under another pad's scalar field", footprints:
      `${footprint("J1", 11, 0, 0, pad(12, "SIG", `(pinfunction "A" ${pad(32)})`))} ${footprint("J2", 21, 10, 0)}` },
  ])("leaves terminal connectivity unassessed for $name", async ({ footprints }) => {
    const source = pcb({ footprints }), f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("unassessed");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each(["pinfunction", "pintype", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio",
    "die_length", "zone_connect", "thermal_gap", "thermal_bridge_width", "thermal_bridge_angle", "roundrect_rratio"])(
    "rejects malformed pad scalar %s with child forms", async field => {
      const value = ["pinfunction", "pintype"].includes(field) ? '"passive"' : "0";
      const source = pcb({ footprints: `${footprint("J1", 11, 0, 0, pad(12, "SIG", `(${field} ${value} (future 1))`))}
        ${footprint("J2", 21, 10, 0)}` }), f = await calculatorFixture();
      const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
      expect(result.routeCompleteness.status).toBe("unassessed");
      expect(result.numericalTarget.status).toBe("unassessed");
      expect(f.runner).not.toHaveBeenCalled();
    });

  it.each([
    { name: "pad", extra: `(property "hidden" "metadata" ${pad(32)})` },
    { name: "footprint", extra: `(property "hidden" "metadata" ${footprint("J3", 31, 4, 0)})` },
  ])("does not hide a nested $name inside board metadata", async ({ extra }) => {
    const source = pcb({ extra }), f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("unassessed");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([
    { name: "copper line", form: `(gr_line (start 2 0) (end 8 0) (stroke (width 0.2) (type default)) (layer "F.Cu") (uuid "${id(40)}"))` },
    { name: "copper polygon", form: `(gr_poly (pts (xy 2 0) (xy 3 0) (xy 3 1) (xy 2 1)) (stroke (width 0) (type default)) (fill solid) (layer "F.Cu") (uuid "${id(40)}"))` },
    { name: "copper text", form: `(gr_text "COPPER" (at 3 0) (layer "F.Cu") (uuid "${id(40)}") (effects (font (size 1 1) (thickness 0.2))))` },
    { name: "zone", form: zone("OTHER", "B.Cu", id(103)) },
  ].flatMap(item => ["property", "setup", "group"].map(parent => ({ ...item, parent }))))(
    "does not omit $name nested under board $parent metadata", async ({ form, parent }) => {
      const source = parent === "setup" ? pcb().replace("(setup (stackup", `(setup ${form} (stackup`)
        : pcb({ extra: parent === "property" ? `(property "hidden" "metadata" ${form})` : `(group "metadata" ${form})` });
      const f = await calculatorFixture();
      const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
      expect(result.routeCompleteness.status).toBe("unassessed");
      expect(result.numericalTarget.status).toBe("unassessed");
      expect(f.runner).not.toHaveBeenCalled();
    });

  it("does not exempt a fake stackup nested under metadata from the copper inventory", async () => {
    const source = pcb({ extra: `(property "hidden" "metadata" (stackup (layer "F.Cu")))` });
    const f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("unassessed");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each([
    { name: "line", graphic: `(fp_line (start 1 0) (end 9 0) (stroke (width 0.2) (type default)) (layer "F.Cu") (uuid "${id(40)}"))` },
    { name: "text", graphic: `(fp_text user "COPPER" (at 3 0) (layer "F.Cu") (uuid "${id(40)}") (effects (font (size 1 1) (thickness 0.2))))` },
  ])("does not ignore footprint-local copper $name", async ({ graphic }) => {
    const source = pcb({ footprints: `${footprint("J1", 11, 0, 0, `${pad(12)} ${graphic}`)} ${footprint("J2", 21, 10, 0)}` });
    const f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("unassessed");
    expect(result.numericalTarget.status).toBe("unassessed");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it("uses exact cardinal footprint transforms for the terminal anchors", async () => {
    const source = pcb({ footprints: `${footprint("J1", 11, 0, 1, pad(12).replace("(at 0 0)", "(at 1 0)"), 90)}
      ${footprint("J2", 21, 10, 0)}` });
    const f = await calculatorFixture();
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source), calculator: f.calculator });
    expect(result.routeCompleteness.status).toBe("complete_source_chain");
    expect(result.numericalTarget.status).toBe("within_tolerance");
  });

  it.each([
    { name: "missing zone", reference: "" }, { name: "wrong zone UUID", reference: zone("GND", "B.Cu", id(102)) },
    { name: "wrong zone net", reference: zone("OTHER") }, { name: "wrong zone layer", reference: zone("GND", "F.Cu") },
  ])("does not match a reference declaration with $name", async ({ reference }) => {
    const source = pcb({ reference });
    const result = await assessSavedMicrostrip({ savedPcbBytes: Buffer.from(source), request: requestFor(source) });
    expect(result.referenceRequirements).toMatchObject({ status: "unassessed", declarationStatus: "unassessed" });
    expect(result.boardAccepted).toBe(false);
  });

  it.each([
    (request: ReturnType<typeof requestFor>) => ({ ...request, boardAccepted: true }),
    (request: ReturnType<typeof requestFor>) => ({ ...request, referenceCoveragePassed: true }),
    (request: ReturnType<typeof requestFor>) => ({ ...request, geometry: { widthNm: 300000, totalLengthNm: 10000000 } }),
    (request: ReturnType<typeof requestFor>) => ({ ...request, expectedSourceIdentity: { ...request.expectedSourceIdentity, approved: true } }),
    (request: ReturnType<typeof requestFor>) => ({ ...request, reference: { ...request.reference, fresh: true } }),
    (request: ReturnType<typeof requestFor>) => ({ ...request, construction: { ...request.construction, authority: "qualified_fabricator" } }),
    (request: ReturnType<typeof requestFor>) => ({ ...request, construction: { ...request.construction,
      dielectric: { ...request.construction.dielectric, approved: true } } }),
    (request: ReturnType<typeof requestFor>) => ({ ...request, construction: { ...request.construction,
      conductor: { ...request.construction.conductor, qualified: true } } }),
    (request: ReturnType<typeof requestFor>) => ({ ...request, terminals: [{ ...request.terminals[0], complete: true }, request.terminals[1]] }),
  ])("rejects caller-injected authority or derived geometry at every request boundary", inject => {
    expect(savedMicrostripRequestSchema.safeParse(inject(requestFor(pcb()))).success).toBe(false);
  });

  it.each([
    { signalLayer: "In1.Cu" }, { signalLayer: "*.Cu" }, { terminals: [{ reference: "J1", pad: "1" }] },
    { terminals: [{ reference: "J1", pad: "1" }, { reference: "J2", pad: "1" }, { reference: "J3", pad: "1" }] },
    { targetOhm: 0 }, { absoluteToleranceOhm: -1 }, { frequencyHz: 0 },
    { expectedSourceIdentity: { algorithm: "sha256", digest: "a".repeat(64) } },
  ])("rejects unsupported or incomplete requests %j", change => {
    expect(savedMicrostripRequestSchema.safeParse({ ...requestFor(pcb()), ...change }).success).toBe(false);
  });
});

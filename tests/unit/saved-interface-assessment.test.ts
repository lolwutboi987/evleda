import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { assessSavedInterface } from "../../src/harness/saved-interface-assessment.js";
import { createKicadTransmissionLineCalculator, KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION, KICAD_TRANSMISSION_LINE_SOURCE_COMMIT,
  type KicadTransmissionLineCalculator } from "../../src/integrations/kicad-transmission-line.js";
import type { BoundedProcessOptions, BoundedProcessResult } from "../../src/integrations/bounded-process.js";
import { interfaceConstructionBundle, interfaceConstructionDraft, constructionAssertion } from "../helpers/interface-construction-bundle.js";
import { usbChannelBundle, usbChannelDraft } from "../helpers/usb-channel-bundle.js";
import { usbChannelPcb } from "../helpers/usb-channel-source.js";
import { fourLayerPlaneDraft } from "../helpers/four-layer-plane-bundle.js";
import { createFourLayerConstructionBoardSeed } from "../../src/harness/interface-construction-seed.js";
import { parseFreshPcbStackup } from "../../src/harness/fresh-kicad-parser.js";

const ownedDirectories: string[] = [];
afterEach(async () => { for (const directory of ownedDirectories.splice(0)) { const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) throw new Error("Unsafe fixture cleanup"); await rm(resolved, { recursive: true, force: true }); } });
const id = (value: number) => `22222222-2222-4222-8222-${value.toString(16).padStart(12, "0")}`;
function draft(model = true): Record<string, any> {
  const value = interfaceConstructionDraft(); value.interfaceRequirements.construction.surfaceFinish = "bare copper";
  if (model) value.interfaceRequirements.interfaces[0].impedance = { mode: "differential", targetOhms: 100, toleranceOhms: 1, frequencyHz: 100_000_000,
    constructionId: "STACK", source: constructionAssertion() };
  return value;
}
function parallelDraft(maximumDistanceToEndpointMm = 0.5) {
  const value = draft(false), component = { ...structuredClone(value.components[0]), reference: "R1" };
  value.components.push(component); value.placementConstraints.push({ ...value.placementConstraints[0], reference: "R1" });
  for (const [index, net] of ["DP", "DN", "GND"].entries()) value.nets.find((item: any) => item.name === net).endpoints.push({ reference: "R1", pin: String(index + 1) });
  for (const [index, net] of ["DP", "DN"].entries()) {
    const route = value.routingConstraints.nets.find((item: any) => item.net === net); route.topology = "tree";
    route.referencePath.terminalReferences.push({ signalEndpoint: { reference: "R1", pin: String(index + 1) }, referenceEndpoint: { reference: "R1", pin: "3" } });
  }
  value.interfaceRequirements.interfaces[0].terminations.receiver = { kind: "parallel", componentReference: "R1", positivePin: "1", negativePin: "2",
    resistanceOhms: 100, maximumDistanceToEndpointMm, source: constructionAssertion() };
  return value;
}
const track = (uuid: number, net: string, start: string, end: string, width = "0.5") => `(segment (start ${start}) (end ${end}) (width ${width}) (layer "F.Cu") (net "${net}") (uuid "${id(uuid)}"))`;
const pad = (uuid: number, number: string, net: string, at: string, extra = "") => `(pad "${number}" smd rect (at ${at}) (size 0.5 0.5) (layers "F.Cu" "F.Paste" "F.Mask") (net "${net}") (uuid "${id(uuid)}") ${extra})`;
const footprint = (uuid: number, reference: string, at: string, pads: string) => `(footprint "Fixture:Terminal" (layer "F.Cu") (at ${at}) (uuid "${id(uuid)}") (property "Reference" "${reference}") ${pads})`;
const zone = `(zone (net "GND") (layer "B.Cu") (uuid "${id(100)}") (connect_pads yes (clearance 0.3)) (min_thickness 0.25)
  (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy -2 -2) (xy 12 -2) (xy 12 3) (xy -2 3))))`;
const stackup = `(layer "F.Mask" (type "Top Solder Mask") (thickness 0)) (layer "F.Cu" (type "copper") (thickness 0.035))
  (layer "dielectric 1" (type "core") (thickness 1.5) (material "fixture laminate") (epsilon_r 4) (loss_tangent 0.02))
  (layer "B.Cu" (type "copper") (thickness 0.035)) (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0)) (copper_finish "bare copper")`;
interface SourceOptions { tracks?: string; footprints?: string; stackup?: string; extra?: string; zone?: string; thickness?: string }
function pcb(options: SourceOptions = {}) {
  return `(kicad_pcb (version 20260206) (general (thickness ${options.thickness ?? "1.57"}))
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user) (13 "F.Paste" user) (15 "B.Paste" user))
    (setup (stackup ${options.stackup ?? stackup}))
    ${options.footprints ?? footprint(10, "J1", "0 0", pad(11, "1", "DP", "0 0") + pad(12, "2", "DN", "0 0.75") + pad(13, "3", "GND", "0 2"))
      + footprint(20, "J2", "10 0", pad(21, "1", "DP", "0 0") + pad(22, "2", "DN", "0 0.75") + pad(23, "3", "GND", "0 2"))}
    ${options.tracks ?? track(1, "DP", "0 0", "10 0") + track(2, "DN", "0 0.75", "10 0.75")}
    ${options.zone ?? zone} ${options.extra ?? ""})`;
}
function unit(name: string) { return ["H", "T", "PHYS_WIDTH", "PHYS_S", "PHYS_LEN", "H_T", "ROUGH"].includes(name) ? "m" : name === "FREQUENCY" ? "Hz" : name === "SIGMA" ? "S/m" : "1"; }
async function calculatorFixture(odd = 50, onDispatch?: (options: BoundedProcessOptions) => void | Promise<void>, protocol = 4) {
  const cwd = await mkdtemp(path.join(tmpdir(), "evleda-saved-interface-")); ownedDirectories.push(cwd);
  const executablePath = path.join(cwd, "fixture.exe"), bytes = Buffer.from("Pinned numerical process-port fixture; never executable code"); await writeFile(executablePath, bytes);
  const runner = vi.fn(async (options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    await onDispatch?.(options);
    const inputs = Object.fromEntries(options.args.filter(arg => arg.includes("=")).map(arg => { const [name, value] = arg.split("=");
      return [name!, value === "absent" ? { value: "absent", unit: "1" } : { value: Number(value), unit: unit(name!) }]; }));
    return { command: options.command, args: options.args, cwd: options.cwd, exitCode: 0, stderr: "", durationMs: 1, startedAt: "2026-09-10T00:00:00Z",
      stdout: JSON.stringify({ schemaVersion: protocol, implementationRevision: protocol === 4 ? KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION : "evleda-uncovered-microstrip-v1",
        sourceCommit: KICAD_TRANSMISSION_LINE_SOURCE_COMMIT, model: "coupled_microstrip", operation: "analyze", converged: true, valid: true, inputs,
        results: { PHYS_WIDTH: { ...inputs.PHYS_WIDTH, status: "ok" }, PHYS_S: { ...inputs.PHYS_S, status: "ok" }, PHYS_LEN: { ...inputs.PHYS_LEN, status: "ok" },
          Z0_O: { value: odd, unit: "ohm", status: "ok" }, Z0_E: { value: 80, unit: "ohm", status: "ok" }, Z_DIFF: { value: 121, unit: "ohm", status: "ok" } } }) };
  });
  const calculator = await createKicadTransmissionLineCalculator({ executablePath, cwd, environment: {}, expectedExecutableIdentity: { sha256: contentIdentity(bytes).digest, sizeBytes: bytes.length }, runner });
  return { calculator, runner };
}
const assess = (source: string, inputDraft = draft(), calculator?: KicadTransmissionLineCalculator) => assessSavedInterface({ savedPcbBytes: Buffer.from(source), compilationBundle: interfaceConstructionBundle(inputDraft), interfaceId: "LINK", ...(calculator ? { calculator } : {}) });

describe("saved interface source and authority boundaries", () => {
  it("retains a modeled channel body interval without claiming launch, branch, resistor or protection coverage", async () => {
    const inputDraft = usbChannelDraft();
    inputDraft.interfaceRequirements.construction.surfaceFinish = "bare copper";
    inputDraft.interfaceRequirements.interfaces[0].impedance = { mode: "differential", targetOhms: 100, toleranceOhms: 1,
      frequencyHz: 100_000_000, constructionId: "STACK", source: constructionAssertion() };
    const fixture = await calculatorFixture(), result = await assessSavedInterface({ savedPcbBytes: Buffer.from(usbChannelPcb().replace('(copper_finish "fixture bare copper")', '(copper_finish "bare copper")')),
      compilationBundle: usbChannelBundle(inputDraft), interfaceId: "LINK", calculator: fixture.calculator });
    expect(result.impedance.intervals.length).toBeGreaterThan(0);
    expect(result.impedance.intervals.every(interval => interval.status === "within_tolerance"), JSON.stringify(result.impedance.intervals.map(interval => interval.reasons))).toBe(true);
    expect(result.impedance.completeRouteModelCoverage).toBe(false);
    expect(result.impedance.unmodeledEffects).toEqual(expect.arrayContaining(["neckdowns", "branch_taps", "series_resistors", "protection_devices", "complete_channel"]));
    expect(result.interfaceAccepted).toBe(false); expect(result.fabricationAuthorized).toBe(false);
  });
  it("binds actual complete saved geometry and exact construction to an authenticated requirement", async () => {
    const source = pcb(), bundle = interfaceConstructionBundle(draft(false)), result = await assessSavedInterface({ savedPcbBytes: Buffer.from(source), compilationBundle: bundle, interfaceId: "LINK" });
    expect(result.sourceIdentity).toEqual(contentIdentity(source)); expect(result.bundleIdentity).toEqual(bundle.identity);
    expect(result.contractIdentity).toEqual(bundle.contract.identity); expect(result.verificationPlanIdentity).toEqual(bundle.verificationPlan.identity);
    expect(result.requirementIdentity).toEqual(canonicalIdentity(bundle.contract.interfaceRequirements!.interfaces[0], "evleda.saved-interface-requirement.v1"));
    expect(result.sourceInventory).toMatchObject({ status: "complete", projectionComplete: true });
    expect(result.sourceInventory.selected.tracks).toHaveLength(2); expect(result.sourceInventory.selected.pads).toHaveLength(4);
    expect(result.sourceInventory.observations).toHaveLength(6); expect(result.geometry!.checks.topology.status).toBe("pass");
    expect(result.construction).toMatchObject({ status: "matched_saved_declaration", observed: { boardThicknessNm: 1570000, dielectricThicknessNm: 1500000,
      frontCopperThicknessNm: 35000, backCopperThicknessNm: 35000, frontMaskThicknessNm: 0, backMaskThicknessNm: 0 } });
    expect(result.referenceRequirements).toMatchObject({ declarationStatus: "matched_saved_zone", memberNets: ["DP", "DN"], fillFreshness: "not_verified", wholeRouteCoverage: "not_evaluated" });
    expect(result.terminations.status).toBe("matched_source_facts"); expect(result.impedance.status).toBe("not_requested");
    expect(result.boardAccepted).toBe(false); expect(result.interfaceAccepted).toBe(false); expect(result.fabricationAuthorized).toBe(false);
    const { identity, ...payload } = result; expect(identity).toEqual(canonicalIdentity(payload, result.schemaVersion)); expect(Object.isFrozen(result.sourceInventory.selected)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("(kicad_pcb");
  });
  it("rejects structural/copy bundles, unknown interfaces and forged calculators before any calculation", async () => {
    const bundle = interfaceConstructionBundle(draft()), args = { savedPcbBytes: Buffer.from(pcb()), compilationBundle: bundle, interfaceId: "LINK" };
    await expect(assessSavedInterface({ ...args, compilationBundle: structuredClone(bundle) })).rejects.toThrow("authenticated");
    await expect(assessSavedInterface({ ...args, interfaceId: "UNKNOWN" })).rejects.toThrow("interface ID");
    await expect(assessSavedInterface({ ...args, calculator: { calculate: vi.fn() } })).rejects.toThrow("factory-bound");
  });
  it("copies the exact saved bytes before any awaited dispatch and takes all targets from the bound bundle", async () => {
    const source = pcb(), savedPcbBytes = Buffer.from(source), bundle = interfaceConstructionBundle(draft());
    const release = Promise.withResolvers<void>(), fixture = await calculatorFixture(50, () => release.promise);
    const pending = assessSavedInterface({ savedPcbBytes, compilationBundle: bundle, interfaceId: "LINK", calculator: fixture.calculator });
    savedPcbBytes.fill(0); release.resolve(); const result = await pending;
    expect(result.sourceIdentity).toEqual(contentIdentity(source)); expect(result.sourceInventory.status).toBe("complete");
    expect(result.impedance.targetOhm).toBe(100); expect(result.impedance.intervals[0]!.calculatedDifferentialOhm).toBe(100);
  });
  it.each([
    ["nested copper", () => pcb({ extra: `(group (segment (start 0 0) (end 1 0) (width 0.5) (layer "F.Cu") (net "DP") (uuid "${id(400)}")))` })],
    ["unknown selected copper", () => pcb({ extra: `(gr_rect (start 0 0) (end 1 1) (stroke (width 0.1) (type default)) (fill solid) (layer "F.Cu") (uuid "${id(400)}"))` })],
    ["arc", () => pcb({ extra: `(arc (start 0 0) (mid 1 1) (end 2 0) (width 0.5) (layer "F.Cu") (net "DP") (uuid "${id(400)}"))` })],
    ["duplicate UUID", () => pcb({ extra: track(1, "DP", "0 1", "10 1") })],
    ["split physical pad", () => pcb({ extra: footprint(400, "J3", "5 0", pad(401, "1", "DP", "0 0") + pad(402, "1", "DN", "0 0.75")) }).replace('(property "Reference" "J3")', '(property "Reference" "J1")')],
  ] as const)("leaves incomplete %s inventory unassessed without inventing disconnected-route failures", async (_name, make) => {
    const result = await assess(make(), draft(false)); expect(result.sourceInventory.status).toBe("unsupported"); expect(result.sourceInventory.projectionComplete).toBe(false);
    expect(result.geometry === null || result.geometry.checks.topology.status === "not_assessed").toBe(true); expect(result.impedance.status).toBe("not_requested");
  });
  it("retains a selected via and independently fails the transition policy", async () => {
    const result = await assess(pcb({ extra: `(via (at 5 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "DP") (uuid "${id(400)}"))` }));
    expect(result.sourceInventory.status).toBe("complete"); expect(result.sourceInventory.selected.vias).toHaveLength(1);
    expect(result.geometry!.checks.transitions.status).toBe("fail"); expect(result.geometry!.viaObservations[0]!.unusedBarrel).toBe("not_assessed");
    expect(result.impedance.intervals).toEqual([]);
  });
  it("retains source identities for unsupported route forms instead of only a global omission reason", async () => {
    const arc = `(arc (start 0 0) (mid 1 1) (end 2 0) (width 0.5) (layer "F.Cu") (net "DP") (uuid "${id(400)}"))`;
    const result = await assess(pcb({ extra: arc }));
    expect(result.sourceInventory.observations).toContainEqual({ kind: "unsupported_route", uuid: id(400), net: "DP", sourceIdentity: contentIdentity(arc), status: "unsupported",
      reasons: [{ code: "UNSUPPORTED_RETAINED_ROUTE_FORM", message: "A complete retained route form has no supported selected-primitive projection; its source identity cannot be omitted." }] });
  });
  it("does not discard a via using an unresolved raw foreign-net label", async () => {
    const via = `(via (at 5 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 999 "GND") (uuid "${id(400)}"))`;
    const result = await assess(pcb({ extra: via })); expect(result.sourceInventory.status).toBe("unsupported");
    expect(result.sourceInventory.observations.some(item => item.kind === "unsupported_route" && item.uuid === id(400) && item.sourceIdentity.digest === contentIdentity(via).digest)).toBe(true);
  });
  it("preserves unsupported pad identities and does not assess a supported subset as complete", async () => {
    const source = pcb().replace('(pad "1" smd rect', '(pad "1" smd custom'); const result = await assess(source);
    expect(result.sourceInventory.status).toBe("unsupported"); expect(result.sourceInventory.observations.some(item => item.kind === "pad" && item.status === "unsupported")).toBe(true);
    expect(result.sourceInventory.selected.tracks).toHaveLength(2); expect(result.geometry!.checks.topology.status).toBe("not_assessed");
  });
  it("preserves independently known width failures beside unsupported physical pads", async () => {
    const source = pcb({ tracks: track(1, "DP", "0 0", "10 0", "0.7") + track(2, "DN", "0 0.75", "10 0.75") }).replace('(pad "1" smd rect', '(pad "1" smd custom');
    const result = await assess(source); expect(result.sourceInventory.status).toBe("unsupported"); expect(result.geometry!.inventoryComplete).toBe(false);
    expect(result.geometry!.checks.width.status).toBe("fail"); expect(result.geometry!.checks.topology.status).toBe("not_assessed");
  });
  it("admits only characterized direct saved zone fill contours without treating the cache as fresh", async () => {
    const filled = zone.slice(0, -1) + '(filled_polygon (layer "B.Cu") (pts (xy -1 -1) (xy 11 -1) (xy 11 2) (xy -1 2))))';
    const result = await assess(pcb({ zone: filled }), draft(false)); expect(result.sourceInventory.status).toBe("complete");
    expect(result.referenceRequirements.savedFillCachePresent).toBe(true); expect(result.referenceRequirements.fillFreshness).toBe("not_verified");
  });
  it("retains branch and crossing diagnostics in the full measured geometry", async () => {
    const branch = await assess(pcb({ extra: track(400, "DP", "5 0", "5 -1") }));
    expect(branch.geometry!.routes.positive.stubs).toHaveLength(1); expect(branch.geometry!.checks.stubs.status).toBe("fail");
    const crossing = await assess(pcb({ extra: track(400, "DP", "5 -1", "5 1") }));
    expect(crossing.geometry!.checks.topology.status).toBe("fail"); expect(crossing.geometry!.routes.positive.reasons).toContain("PROPER_CROSSING");
  });
  it("keeps a saved reference declaration separate from actual coverage and returns", async () => {
    const result = await assess(pcb({ zone: zone.replace('(xy -2 -2) (xy 12 -2) (xy 12 3) (xy -2 3)', '(xy 100 100) (xy 110 100) (xy 110 110) (xy 100 110)') }), draft(false));
    expect(result.referenceRequirements.declarationStatus).toBe("matched_saved_zone"); expect(result.referenceRequirements.wholeRouteCoverage).toBe("not_evaluated");
    expect(result.referenceRequirements.referenceElectricalEligibility).toBe("not_evaluated");
  });
});

describe("exact saved construction matching", () => {
  it.each([
    ["general thickness", () => pcb({ thickness: "1.6" })],
    ["copper thickness", () => pcb({ stackup: stackup.replace('(thickness 0.035)', '(thickness 0.036)') })],
    ["dielectric thickness", () => pcb({ stackup: stackup.replace('(thickness 1.5)', '(thickness 1.4)') })],
    ["masked source", () => pcb({ stackup: stackup.replace('(thickness 0)', '(thickness 0.01)') })],
    ["material", () => pcb({ stackup: stackup.replace('fixture laminate', 'different laminate') })],
    ["binary64-hidden permittivity difference", () => pcb({ stackup: stackup.replace('(epsilon_r 4)', '(epsilon_r 4.0000000000000001)') })],
    ["binary64-hidden loss difference", () => pcb({ stackup: stackup.replace('(loss_tangent 0.02)', '(loss_tangent 0.020000000000000001)') })],
    ["finish", () => pcb({ stackup: stackup.replace('bare copper', 'ENIG') })],
  ] as const)("reports known %s mismatch while retaining route measurements", async (_name, make) => {
    const result = await assess(make()); expect(result.construction.status).toBe("failed_saved_declaration");
    expect(result.geometry!.routes.positive.mainLength).toEqual({ twiceAxisNm: "20000000", twiceDiagonalNm: "0" });
    expect(result.impedance.intervals[0]!.status).toBe("unassessed");
  });
  it("keeps missing/ambiguous declarations unknown and known mismatches failure-dominant", async () => {
    const missing = await assess(pcb({ stackup: stackup.replace('(layer "F.Mask" (type "Top Solder Mask") (thickness 0))', '') }));
    expect(missing.construction.status).toBe("unassessed");
    const mixed = await assess(pcb({ thickness: "1.6", stackup: stackup.replace('(layer "F.Mask" (type "Top Solder Mask") (thickness 0))', '') }));
    expect(mixed.construction.status).toBe("failed_saved_declaration");
    const duplicate = await assess(pcb({ stackup: stackup.replace('(epsilon_r 4)', '(epsilon_r 4) (epsilon_r 4)') }));
    expect(duplicate.construction.status).toBe("unassessed");
  });
  it("does not ignore an exterior dielectric or positive coating that contradicts the declared air exterior", async () => {
    const exterior = '(layer "dielectric 0" (type "core") (thickness 0.1) (material "fixture laminate") (epsilon_r 4) (loss_tangent 0.02))';
    const extraDielectric = await assess(pcb({ stackup: stackup.replace('(layer "F.Cu"', `${exterior} (layer "F.Cu"`) }));
    expect(extraDielectric.construction.status).toBe("failed_saved_declaration");
    const coating = await assess(pcb({ stackup: '(layer "F.SilkS" (type "Top Silk Screen") (thickness 0.01)) ' + stackup }));
    expect(coating.construction.status).toBe("failed_saved_declaration");
  });
  it("uses requirement-sized exact limits independently of coordinate bounds", async () => {
    const value = draft(false); value.interfaceRequirements.interfaces[0].geometry.maxEtchLengthMm = 3000;
    value.interfaceRequirements.interfaces[0].geometry.maxEtchSkewMm = 3000; value.interfaceRequirements.interfaces[0].geometry.maxUncoupledLengthMm = 3000;
    const result = await assess(pcb(), value); expect(result.sourceInventory.status).toBe("complete"); expect(result.geometry!.checks.length.status).toBe("pass");
  });
});

describe("source termination pin and distance observations", () => {
  const terminal = (at: string) => footprint(400, "R1", at, pad(401, "1", "DP", "0 0") + pad(402, "2", "DN", "0 0.75") + pad(403, "3", "GND", "0 2"));
  it("measures parallel termination pins on the whole route without verifying the declared resistor", async () => {
    const result = await assess(pcb({ extra: terminal("9.9 0") }), parallelDraft());
    expect(result.terminations.status).toBe("matched_source_facts"); expect(result.terminations.pins).toHaveLength(2);
    expect(result.terminations.pins[0]!.distanceSquaredNm2).toBe("10000000000"); expect(result.terminations.resistanceVerification).toBe("caller_assertion_only");
    expect(result.geometry!.routes.positive.stubs).toEqual([]);
  });
  it("fails known endpoint-distance violations and accepts large valid declared limits", async () => {
    const far = await assess(pcb({ extra: terminal("5 0") }), parallelDraft()); expect(far.terminations.status).toBe("failed_source_facts");
    const large = await assess(pcb({ extra: terminal("5 0") }), parallelDraft(3000)); expect(large.terminations.status).toBe("matched_source_facts");
    expect(large.terminations.pins[0]!.maximumDistanceNm).toBe(3_000_000_000);
  });
  it("compares fractional-nanometre termination limits exactly without throwing", async () => {
    const far = await assess(pcb({ extra: terminal("9.9 0") }), parallelDraft(0.0000001)); expect(far.terminations.status).toBe("failed_source_facts");
    const coincident = await assess(pcb({ extra: terminal("10 0") }), parallelDraft(0.0000001)); expect(coincident.terminations.status).toBe("matched_source_facts");
  });
  it("does not call a pad on a disconnected island attached to the source route", async () => {
    const result = await assess(pcb({ extra: terminal("10.1 0") + track(410, "DP", "10.05 0", "10.15 0") + track(411, "DN", "10.05 0.75", "10.15 0.75") }), parallelDraft());
    expect(result.terminations.status).toBe("failed_source_facts"); expect(result.terminations.pins.every(pin => pin.reasons.some(item => item.code === "TERMINATION_NOT_ON_SOURCE_ROUTE"))).toBe(true);
  });
  it("keeps an actually attached termination fact when unrelated disconnected copper fails topology", async () => {
    const result = await assess(pcb({ extra: terminal("9.9 0") + track(410, "DP", "30 0", "31 0") }), parallelDraft());
    expect(result.geometry!.checks.topology.status).toBe("fail"); expect(result.terminations.status).toBe("matched_source_facts");
  });
});

describe("actual coupled interval numerical observations", () => {
  it.each([["F.Cu", "In1.Cu", "GND_PLANE", .0001, 4.1], ["B.Cu", "In2.Cu", "BACK_GND", .0002, 3.9]] as const)(
    "uses the adjacent %s dielectric in a four-layer model", async (signalLayer, referenceLayer, planeId, expectedHeight, expectedEr) => {
      const value = fourLayerPlaneDraft(), construction = value.interfaceRequirements.construction;
      construction.solderMask = { front: { kind: "absent" }, back: { kind: "absent" } };
      construction.boardThicknessMm = 1.0004;
      construction.surfaceFinish = "bare copper";
      const pair = value.interfaceRequirements.interfaces[0];
      pair.routing.allowedLayers = [signalLayer]; pair.routing.referencePlaneId = planeId;
      pair.impedance = { mode:"differential", targetOhms:100, toleranceOhms:1, frequencyHz:100_000_000, constructionId:"STACK", source:constructionAssertion() };
      for (const route of value.routingConstraints.nets.filter((r: any) => r.topology !== "plane")) {
        route.preferredLayer = signalLayer; route.referencePath.signalLayer = signalLayer; route.referencePath.planeId = planeId;
      }
      const capturedStack = parseFreshPcbStackup(createFourLayerConstructionBoardSeed(construction)).stackupSource!;
      let source = pcb({ thickness:"1.0004", stackup:capturedStack.slice("(stackup".length,-1), zone:zone.replaceAll('"B.Cu"',`"${referenceLayer}"`) })
        .replace('(0 "F.Cu" signal) (2 "B.Cu" signal)', '(0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)');
      if (signalLayer === "B.Cu") source = source.replaceAll('(layer "F.Cu")','(layer "B.Cu")')
        .replaceAll('(layers "F.Cu" "F.Paste" "F.Mask")','(layers "B.Cu" "B.Paste" "B.Mask")');
      const requests: string[][] = [];
      const calculator = await calculatorFixture(50, options => { requests.push([...options.args]); });
      const report = await assess(source,value,calculator.calculator);
      expect(report.construction.status).toBe("matched_saved_declaration");
      expect(requests, JSON.stringify(report.impedance)).toHaveLength(1);
      expect(requests[0]).toContain(`H=${expectedHeight}`);
      expect(requests[0]).toContain(`EPSILONR=${expectedEr}`);
      expect(report.interfaceAccepted).toBe(false);
    });
  it("uses protocol4 uncovered geometry and exactly twice frequency-dependent Z0_O, preserving quasistatic output separately", async () => {
    const fixture = await calculatorFixture(), result = await assess(pcb(), draft(), fixture.calculator);
    expect(fixture.runner).toHaveBeenCalledTimes(1); expect(fixture.runner.mock.calls[0]![0].args).toEqual(expect.arrayContaining([
      "--model", "coupled_microstrip", "H=0.0015", "T=0.000035", "H_T=absent", "PHYS_WIDTH=0.0005", "PHYS_S=0.00025", "PHYS_LEN=0.01", "FREQUENCY=100000000" ]));
    expect(fixture.runner.mock.calls[0]![0].args.some(arg => arg.startsWith("MUR="))).toBe(false);
    expect(result.impedance.intervals[0]).toMatchObject({ status: "within_tolerance", calculatedDifferentialOhm: 100, residualOhm: 0,
      calculation: { impedance: { nativeDifferentialOhm: 121, differentialAtFrequencyOhm: 100 } } });
    expect(result.impedance.status).toBe("unassessed"); expect(result.impedance.completeRouteModelCoverage).toBe(true);
    expect(result.impedance.reasons.some(item => item.code === "FINITE_THICKNESS_APPLICABILITY_UNASSESSED")).toBe(true);
  });
  it("keeps known numerical target misses failure-dominant over model applicability unknowns", async () => {
    const fixture = await calculatorFixture(70), result = await assess(pcb(), draft(), fixture.calculator);
    expect(result.impedance.status).toBe("outside_tolerance"); expect(result.impedance.intervals[0]!.calculatedDifferentialOhm).toBe(140);
  });
  it("retains source facts without a calculator, on calculator failure, and for protocol3", async () => {
    const noCalculator = await assess(pcb()); expect(noCalculator.impedance.intervals[0]!.reasons[0]!.code).toBe("CALCULATOR_UNAVAILABLE");
    const failed = await calculatorFixture(50, () => { throw new Error("fixture failure"); });
    const failure = await assess(pcb(), draft(), failed.calculator); expect(failure.impedance.intervals[0]!.status).toBe("unassessed"); expect(failure.geometry!.checks.topology.status).toBe("pass");
    const old = await calculatorFixture(50, undefined, 3), result = await assess(pcb(), draft(), old.calculator);
    expect(result.impedance.intervals[0]!.status).toBe("unassessed"); expect(result.impedance.intervals[0]!.calculatedDifferentialOhm).toBeNull();
  });
  it("rejects unequal widths instead of averaging them and retains all dimensions", async () => {
    const fixture = await calculatorFixture(), result = await assess(pcb({ tracks: track(1, "DP", "0 0", "10 0") + track(2, "DN", "0 0.75", "10 0.75", "0.6") }), draft(), fixture.calculator);
    expect(fixture.runner).not.toHaveBeenCalled(); expect(result.impedance.intervals[0]).toMatchObject({ positiveWidthNm: 500000, negativeWidthNm: 600000, status: "unassessed" });
    expect(result.geometry!.selected.tracks).toHaveLength(2);
  });
  it("evaluates each actual width section and never turns partial coverage into complete model evidence", async () => {
    const fixture = await calculatorFixture(70), result = await assess(pcb({ tracks: track(1, "DP", "0 0", "5 0") + track(3, "DP", "5 0", "10 0", "0.6") + track(2, "DN", "0 0.75", "10 0.75") }), draft(), fixture.calculator);
    expect(result.impedance.intervals).toHaveLength(2); expect(fixture.runner).toHaveBeenCalledTimes(1);
    expect(result.impedance.intervals.map(item => item.status)).toEqual(["outside_tolerance", "unassessed"]);
    expect(result.impedance.status).toBe("outside_tolerance"); expect(result.impedance.completeRouteModelCoverage).toBe(false);
  });
  it("does not model nonunit substrate/conductor permeability or a published frequency-domain violation", async () => {
    for (const kind of ["substrate", "conductor", "frequency"] as const) {
      const value = draft(); if (kind === "substrate") value.interfaceRequirements.construction.dielectric.substrateRelativePermeability = 2;
      if (kind === "conductor") value.interfaceRequirements.construction.conductor.relativePermeability = 2;
      if (kind === "frequency") { value.interfaceRequirements.interfaces[0].impedance.frequencyHz = 20e9; value.interfaceRequirements.construction.dielectric.frequencyHz = 20e9; }
      const fixture = await calculatorFixture(), result = await assess(pcb(), value, fixture.calculator);
      expect(fixture.runner).not.toHaveBeenCalled(); expect(result.impedance.intervals[0]!.status).toBe("unassessed");
      expect(result.impedance.intervals[0]!.reasons[0]!.code).toBe(kind === "frequency" ? "PUBLISHED_MODEL_ENVELOPE_EXCEEDED" : "MAGNETIC_MODEL_UNSUPPORTED");
      expect(result.geometry!.checks.topology.status).toBe("pass");
    }
  });
  it("uses the exact clipped diagonal interval length and its actual edge gap", async () => {
    const footprints = footprint(10, "J1", "0 0", pad(11, "1", "DP", "0 0") + pad(12, "2", "DN", "0 1.2") + pad(13, "3", "GND", "0 2"))
      + footprint(20, "J2", "10 10", pad(21, "1", "DP", "0 0") + pad(22, "2", "DN", "0 1.2") + pad(23, "3", "GND", "0 2"));
    const fixture = await calculatorFixture(), result = await assess(pcb({ footprints, tracks: track(1, "DP", "0 0", "10 10") + track(2, "DN", "0 1.2", "10 11.2") }), draft(), fixture.calculator);
    expect(fixture.runner).toHaveBeenCalledTimes(1); const interval = result.impedance.intervals[0]!;
    expect(interval.length).toEqual({ twiceAxisNm: "0", twiceDiagonalNm: "18800000" });
    expect(interval.numericalLengthNm).toBe(9400000 * Math.SQRT2); expect(interval.numericalGapNm).toBe(Math.sqrt(720000000000) - 500000);
    expect(interval.calculation!.request.parameters.PHYS_LEN).toBe(interval.numericalLengthNm! / 1e9);
    expect(result.impedance.completeRouteModelCoverage).toBe(false);
  });
  it("decides published gap/frequency boundaries exactly before floating-point calculator conversion", async () => {
    const value = draft(); value.interfaceRequirements.construction.dielectric.thicknessMm = 2.5; value.interfaceRequirements.construction.boardThicknessMm = 2.57;
    value.interfaceRequirements.construction.dielectric.frequencyHz = 8e9; value.interfaceRequirements.interfaces[0].impedance.frequencyHz = 8e9;
    const source = pcb({ thickness: "2.57", stackup: stackup.replace('(thickness 1.5)', '(thickness 2.5)') }), fixture = await calculatorFixture();
    const boundary = await assess(source, value, fixture.calculator); expect(fixture.runner).toHaveBeenCalledTimes(1);
    expect(boundary.impedance.intervals[0]!.applicability).toMatchObject({ gapToHeightRatio: 0.1, frequencyGHzTimesHeightMm: 20 });
    value.interfaceRequirements.construction.dielectric.frequencyHz += 1; value.interfaceRequirements.interfaces[0].impedance.frequencyHz += 1;
    const outside = await assess(source, value, fixture.calculator); expect(fixture.runner).toHaveBeenCalledTimes(1);
    expect(outside.impedance.intervals[0]!.reasons[0]!.code).toBe("PUBLISHED_MODEL_ENVELOPE_EXCEEDED");
  });
  it("retains every interval and dispatches no model subset when the full work budget is exceeded", async () => {
    const tracks = Array.from({ length: 129 }, (_, i) => track(1000 + i, "DP", `${(i * 0.05).toFixed(2)} 0`, `${((i + 1) * 0.05).toFixed(2)} 0`, i % 2 ? "0.6" : "0.5")).join("")
      + track(2, "DN", "0 0.75", "6.45 0.75");
    const source = pcb({ tracks }).replace('(at 10 0)', '(at 6.45 0)'), fixture = await calculatorFixture(), result = await assess(source, draft(), fixture.calculator);
    expect(result.sourceInventory.status).toBe("complete"); expect(result.impedance.intervals).toHaveLength(129);
    expect(result.impedance.intervals.every(interval => interval.status === "unassessed")).toBe(true); expect(fixture.runner).not.toHaveBeenCalled();
    expect(result.impedance.reasons.some(item => item.code === "MODEL_INTERVAL_WORK_BOUND")).toBe(true);
  });
});

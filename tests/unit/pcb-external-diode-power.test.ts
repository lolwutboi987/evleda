import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { closePcbPlaneDesignIntentDraft, parsePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-contract.js";
import { parsePcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { assertPcbDerivedPowerBindingCurrent, createPcbDerivedPowerBinding, parsePcbDerivedPowerBinding } from "../../src/harness/pcb-derived-power.js";
import { cleanupDerivedPowerFixtures, derivedPowerFixture } from "../helpers/derived-power-bundle.js";
import { externalDiodePowerDraft, externalDiodePowerFixture, externalDiodePowerStock } from "../helpers/external-diode-power-bundle.js";

afterEach(cleanupDerivedPowerFixtures);
const declaration = (draft: Record<string, any>) => draft.derivedPowerSources.find((entry: any) => entry.id === "EXTERNAL_VSYS");
const compile = (draft: Record<string, any>, stock = externalDiodePowerStock()) =>
  compilePcbPlaneDesignIntentDraft(draft, { libraryResolver: stock.resolver, deepRuleCatalog: loadDeepRuleCatalog() });

describe("explicit source-bound external input through one forward Schottky", () => {
  it("binds the exact declared connector, A-to-K diode, power_in consumer and common return", () => {
    const { bundle, dependencies, resolver } = externalDiodePowerFixture();
    const binding = bundle.derivedPowerBinding!, path = binding.paths.find(value => value.id === "EXTERNAL_VSYS")!;
    expect(path.externalPowerInput!.id).toBe("INPUT");
    expect(path.netSequence).toEqual(["VIN", "VSYS"]);
    expect(path.requiredNets).toEqual(["GND", "VCORE", "VIN", "VSYS"]);
    expect(binding.symbols.map(value => value.reference)).toEqual(["D1", "J1", "L1", "R1", "R2", "U1"]);
    expect(binding.flags.slice(0, 2)).toEqual(bundle.externalPowerBinding!.flags);
    expect(binding.flags.find(value => value.net === "VSYS")!.anchorEndpoint).toEqual({ reference: "U1", pin: "1" });
    expect(bundle.contract.externalPowerInputs).toHaveLength(1);
    expect(bundle.contract.nets.find(value => value.name === "VSYS")!.role).toBe("power");
    expect(bundle.executionGuidance).toContain("diodeForwardDropAssumption");
    expect(() => assertPcbDerivedPowerBindingCurrent(binding, bundle.libraryBinding, resolver)).not.toThrow();
    const bytes = serializePcbPlaneCompilationBundle(bundle);
    expect(serializePcbPlaneCompilationBundle(parsePcbPlaneCompilationBundle(bytes, dependencies))).toEqual(bytes);
  });

  it.each([
    ["unbound external input ID", (d: any) => { declaration(d).externalPowerInput.id = "MISSING"; }],
    ["external input omitted", (d: any) => { delete d.externalPowerInputs; }],
    ["unasserted connector source", (d: any) => { delete declaration(d).externalPowerInput; }],
    ["mismatched declared supply endpoint", (d: any) => { declaration(d).drivingEndpoint = { reference: "D1", pin: "2" }; }],
    ["reversed diode", (d: any) => { declaration(d).path[0] = { reference: "D1", entryPin: "1", exitPin: "2" }; }],
    ["wrong diode pin", (d: any) => { declaration(d).path[0].entryPin = "3"; }],
    ["resistor substituted for diode", (d: any) => { d.components.find((v: any) => v.reference === "D1").symbolLibId = "Device:R"; }],
    ["multiple diode/path steps", (d: any) => { declaration(d).path.push({ reference: "R1", entryPin: "1", exitPin: "2" }); }],
    ["passive connector consumer", (d: any) => { declaration(d).supplyEndpoint = { reference: "D1", pin: "1" }; declaration(d).returnEndpoint = { reference: "D1", pin: "2" }; }],
    ["wrong supply net", (d: any) => { declaration(d).supplyEndpoint.pin = "4"; }],
    ["wrong return component", (d: any) => { declaration(d).returnEndpoint = { reference: "J1", pin: "3" }; }],
    ["wrong return pin", (d: any) => { declaration(d).returnEndpoint.pin = "1"; }],
    ["missing diode drop assertion", (d: any) => { delete declaration(d).externalPowerInput.diodeForwardDropAssumption; }],
    ["empty diode drop assertion", (d: any) => { declaration(d).externalPowerInput.diodeForwardDropAssumption = "  "; }],
    ["missing modes assertion", (d: any) => { delete declaration(d).externalPowerInput.operatingModes; }],
    ["empty modes assertion", (d: any) => { declaration(d).externalPowerInput.operatingModes = ""; }],
    ["missing source assertion", (d: any) => { delete declaration(d).source; }],
    ["missing general operating assumptions", (d: any) => { delete declaration(d).operatingAssumptions; }],
    ["extra external qualification claim", (d: any) => { declaration(d).externalPowerInput.verified = true; }],
  ])("rejects %s before a ready artifact", (_name, mutate) => {
    const draft = externalDiodePowerDraft(); mutate(draft);
    expect(compile(draft).disposition).not.toBe("ready");
  });

  it.each(["id", "diodeForwardDropAssumption", "operatingModes"])("preserves unresolved external %s as null in drafts but rejects closure", field => {
    const draft = externalDiodePowerDraft(), entry = declaration(draft);
    entry.externalPowerInput[field] = null;
    const index = draft.derivedPowerSources.indexOf(entry);
    draft.unresolved = [{ path: `/derivedPowerSources/${index}/externalPowerInput/${field}`, question: `Resolve the external source ${field}.` }];
    const parsed = parsePcbPlaneDesignIntentDraft(draft);
    expect(parsed.derivedPowerSources!.find(value => value.id === "EXTERNAL_VSYS")!.externalPowerInput?.[field as "id" | "diodeForwardDropAssumption" | "operatingModes"]).toBeNull();
    expect(parsed.unresolved[0]!.path).toBe(`/derivedPowerSources/EXTERNAL_VSYS/externalPowerInput/${field}`);
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow();
    const result = compile(draft);
    expect(result.disposition).toBe("needs_clarification");
    expect(result.contract).toBeNull();
  });

  it("keeps all external source fields nullable together without granting a binding", () => {
    const draft = externalDiodePowerDraft();
    declaration(draft).externalPowerInput = { id: null, diodeForwardDropAssumption: null, operatingModes: null };
    expect(() => parsePcbPlaneDesignIntentDraft(draft)).not.toThrow();
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow();
    expect(compile(draft).disposition).toBe("needs_clarification");
  });

  it.each([
    ["wrong A name", (value: string) => value.replace('(name "A"', '(name "ANODE"')],
    ["wrong K name", (value: string) => value.replace('(name "K"', '(name "A"')],
    ["wrong electrical type", (value: string) => value.replace('pin passive', 'pin power_out')],
    ["wrong pin numbering", (value: string) => value.replace('(number "2"', '(number "3"')],
    ["extra third pin", (value: string) => value.replace('(symbol "D_Schottky_1_1"', '(symbol "D_Schottky_1_1" (pin passive line (at 0 5.08 90) (length 2.54) (name "EXTRA") (number "3"))')],
    ["hidden extra unit", (value: string) => value.replace('(symbol "D_Schottky_1_1"', '(symbol "D_Schottky_2_1"')],
  ])("rejects source-inspected diode semantic drift: %s", (_name, mutate) => {
    expect(compile(externalDiodePowerDraft(), externalDiodePowerStock(mutate)).disposition).not.toBe("ready");
  });

  it("rejects a different physical return net despite two valid ground nets", () => {
    const draft = externalDiodePowerDraft();
    const ground = draft.nets.find((value: any) => value.name === "GND");
    const points = [{ reference: "U1", pin: "2" }, { reference: "J1", pin: "4" }];
    for (const point of points) {
      draft.components.find((value: any) => value.reference === point.reference).pins.find((value: any) => value.pin === point.pin).assignment.net = "OTHER_GND";
      for (const net of draft.nets) net.endpoints = net.endpoints.filter((value: any) => value.reference !== point.reference || value.pin !== point.pin);
    }
    draft.nets.push({ ...structuredClone(ground), name: "OTHER_GND", endpoints: points });
    expect(() => closePcbPlaneDesignIntentDraft(draft)).toThrow(/exact declared ground/u);
  });

  it("requires the exact external child, including its descriptor anchors", () => {
    const { bundle, resolver } = externalDiodePowerFixture();
    expect(() => createPcbDerivedPowerBinding(bundle.contract, bundle.libraryBinding, resolver)).toThrow(/external power binding/u);
    const altered = structuredClone(bundle.externalPowerBinding!) as any;
    altered.flags.find((value: any) => value.net === "VIN").anchorEndpoint = { reference: "D1", pin: "2" };
    const { identity: _identity, ...payload } = altered; altered.identity = canonicalIdentity(payload, altered.schemaVersion);
    expect(() => createPcbDerivedPowerBinding(bundle.contract, bundle.libraryBinding, resolver, altered)).toThrow(/exact reconstructed/u);
    expect(() => parsePcbDerivedPowerBinding(bundle.derivedPowerBinding, bundle.contract.identity, undefined)).toThrow();
  });

  it("rejects a source-inspected consumer VIN that is not power_in", () => {
    const stock = externalDiodePowerStock(), draft = externalDiodePowerDraft();
    draft.derivedPowerSources = [declaration(draft)];
    writeFileSync(stock.symbolFiles.Regulator_Switching!, stock.librarySources.Regulator_Switching!.replace('(pin power_in line (at -5.08 5.08 0)', '(pin passive line (at -5.08 5.08 0)'), "utf8");
    const result = compile(draft, stock);
    expect(result.disposition).not.toBe("ready");
    expect(result.issues.map(value => value.message).join(" ")).toMatch(/power_in consumer/u);
  });

  it("rejects a forged non-stock diode source and a rehashed unbound external ID", () => {
    const { bundle, resolver, dependencies } = externalDiodePowerFixture();
    const library = structuredClone(bundle.libraryBinding) as any;
    library.symbols.find((value: any) => value.reference === "D1").source = "project-custom";
    const { identity: _libraryIdentity, ...libraryPayload } = library; library.identity = canonicalIdentity(libraryPayload, library.schemaVersion);
    expect(() => createPcbDerivedPowerBinding(bundle.contract, library, resolver, bundle.externalPowerBinding)).toThrow();
    const forged = structuredClone(bundle) as any;
    forged.derivedPowerBinding.paths.find((value: any) => value.id === "EXTERNAL_VSYS").externalPowerInput.id = "UNBOUND";
    const { identity: _bindingIdentity, ...bindingPayload } = forged.derivedPowerBinding;
    forged.derivedPowerBinding.identity = canonicalIdentity(bindingPayload, forged.derivedPowerBinding.schemaVersion);
    const { identity: _bundleIdentity, ...bundlePayload } = forged; forged.identity = canonicalIdentity(bundlePayload, forged.schemaVersion);
    expect(() => parsePcbPlaneCompilationBundle(forged, dependencies)).toThrow();
  });

  it.each(["Device", "Connector_Generic", "Regulator_Switching", "power"])("rejects raw %s source drift before reconstruction", nickname => {
    const { bundle, dependencies, resolver, symbolFiles, librarySources } = externalDiodePowerFixture();
    const bytes = serializePcbPlaneCompilationBundle(bundle);
    writeFileSync(symbolFiles[nickname]!, `${librarySources[nickname as keyof typeof librarySources]}\n`, "utf8");
    expect(() => assertPcbDerivedPowerBindingCurrent(bundle.derivedPowerBinding!, bundle.libraryBinding, resolver)).toThrow();
    expect(() => parsePcbPlaneCompilationBundle(bytes, dependencies)).toThrow();
  });

  it("keeps the optional extension absent throughout legacy IC L/R artifacts and exact byte roundtrips", () => {
    const { bundle, dependencies } = derivedPowerFixture();
    for (const entry of [...bundle.contract.derivedPowerSources!, ...bundle.derivedPowerBinding!.paths]) expect(entry).not.toHaveProperty("externalPowerInput");
    expect(bundle.executionGuidance).not.toContain("diodeForwardDropAssumption");
    const bytes = serializePcbPlaneCompilationBundle(bundle);
    expect(serializePcbPlaneCompilationBundle(parsePcbPlaneCompilationBundle(bytes, dependencies))).toEqual(bytes);
  });
});

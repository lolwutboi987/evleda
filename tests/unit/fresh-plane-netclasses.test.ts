import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import type { KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef, type PcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createFreshPlaneRules } from "../../src/harness/fresh-plane-rules.js";
import { derivePcbNativeNumericRules } from "../../src/harness/pcb-native-numeric-rules.js";
import { FRESH_NETCLASS_ASSIGNMENT_MODEL } from "../../src/harness/fresh-netclass-assignment.js";
import { materializeFreshNetClasses, parseFreshNetClassSemanticAuthority, parseFreshNetClassPreparationEvidence, readFreshClearanceEvidence,
  assertFreshPlaneReferenceCopperScope } from "../../src/harness/fresh-clearance-evidence.js";
import { materializeFreshPlaneNetClasses, readFreshPlaneNetClassSemanticAuthority, verifyFreshPlaneNetClassSemanticAuthority,
  parseFreshPlaneNetClassMaterialization, parseFreshPlaneNetClassSemanticAuthority, createFreshPlaneNetClassPreparationEvidence,
  parseFreshPlaneNetClassPreparationEvidence, type FreshPlaneNetClassOperationOptions } from "../../src/harness/fresh-plane-netclasses.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { interfaceConstructionBundle } from "../helpers/interface-construction-bundle.js";
import { parseFreshPcbSource, parseFreshPcbStackup } from "../../src/harness/fresh-kicad-parser.js";
import type { PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
const kicad: KicadExecutableIdentity = { kind: "kicad-cli", path: "C:/fixture/kicad-cli.exe", version: "10.0.3", commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
  sha256: "a".repeat(64), sizeBytes: 1, capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
function bundle(prompt = "Synthetic V2 plane net-class preparation.", solid = false) {
  const draft: Record<string, any> = structuredClone(planeDividerDraft());
  if (solid) draft.planes[0].padConnection = { mode: "solid" };
  const compilation = compilePcbPlaneDesignIntentDraft(draft, dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ originalPrompt: prompt, compilation }, dependencies);
}
async function fixture(solid = false, constructionBundle?: PcbPlaneCompilationBundle) {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-plane-classes-")); roots.push(root);
  const compilationBundle = constructionBundle ?? bundle(undefined, solid);
  const project = await preparePlaneFreshProject({ outputDir: root, name: "plane-test", resume: false, compilationBundle,
    compilationBundleRef: createPcbPlaneCompilationBundleRef(compilationBundle) });
  const proPath = path.join(project.projectPath, `${project.name}.kicad_pro`);
  const druPath = path.join(project.projectPath, `${project.name}.kicad_dru`);
  return { project, compilationBundle, options: { project, compilationBundle, kicad }, proPath, druPath };
}
const rehash = <T extends { schemaVersion: string; identity: unknown }>(value: T): T => {
  const { identity: _identity, ...payload } = value;
  return { ...payload, identity: canonicalIdentity(payload, value.schemaVersion) } as T;
};
async function editProject(file: string, edit: (value: any) => void) {
  const value = JSON.parse(await readFile(file, "utf8")); edit(value); await writeFile(file, JSON.stringify(value));
}

const noConnectName = "native isolated terminal J1 / exact arbitrary name";
const standardNoConnectName = "unconnected-(J1-Pin_4-Pad4)";
const ncUuid = (index: number) => `99999999-1111-4111-8111-${String(index).padStart(12, "0")}`;
function noConnectBundle() {
  const draft = planeDividerDraft(), connector = draft.components.find(component => component.reference === "J1")!;
  connector.symbolLibId = "Connector_Generic:Conn_01x04";
  connector.footprintLibId = "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical";
  connector.pins.push({ pin: "4", assignment: { kind: "no_connect" } });
  const libraryResolver: PcbReadOnlyLibraryResolver = {
    resolveSymbol(libraryId) {
      return libraryId === connector.symbolLibId ? { ...genericDividerLibraryResolver.resolveSymbol("Connector_Generic:Conn_01x03")!, libraryId,
        pins: ["1", "2", "3", "4"].map(number => ({ number, function: `Pin ${number}` })) } : genericDividerLibraryResolver.resolveSymbol(libraryId);
    },
    resolveFootprint(libraryId) {
      return libraryId === connector.footprintLibId ? { ...genericDividerLibraryResolver.resolveFootprint("Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical")!, libraryId,
        pads: ["1", "2", "3", "4"] } : genericDividerLibraryResolver.resolveFootprint(libraryId);
    },
  };
  const deps = { libraryResolver, deepRuleCatalog: dependencies.deepRuleCatalog };
  const compilation = compilePcbPlaneDesignIntentDraft(draft, deps);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ originalPrompt: "Offline V2 native NC semantic net-class authority regression.", compilation }, deps);
}

async function noConnectFixture(nativeName = noConnectName, repeated = false) {
  const f = await fixture(false, noConnectBundle());
  await materializeFreshPlaneNetClasses(f.options);
  const initialAuthority = await readFreshPlaneNetClassSemanticAuthority(f.options);
  const beforePcb = await readFile(f.project.pcbPath, "utf8"), contract = f.compilationBundle.contract;
  const footprints = contract.components.map((component, index) => `(footprint ${JSON.stringify(component.footprintLibId)} (uuid "${ncUuid(index + 1)}") (layer "F.Cu") (at ${4 + index * 8} 8)
    (property "Reference" ${JSON.stringify(component.reference)}) (property "Value" ${JSON.stringify(component.value)})
    ${component.pins.map((pin, ordinal) => `(pad ${JSON.stringify(pin.pin)} smd rect (uuid "${ncUuid(100 + index * 10 + ordinal)}") (at ${ordinal * 2} 0) (size 1 1) (layers "F.Cu") (net ${JSON.stringify(pin.assignment.kind === "net" ? pin.assignment.net : nativeName)}))`).join(" ")}
    ${repeated && component.reference === "J1" ? `(pad "4" smd rect (uuid "${ncUuid(900)}") (at 6 2) (size 1 1) (layers "F.Cu") (net ${JSON.stringify(nativeName)}))` : ""})`).join("\n");
  const pcbSource = beforePcb.replace(/\)\s*$/u, `${footprints}\n)\n`);
  const schematicSource = `(kicad_sch (version 20250316) (generator "fixture") ${contract.nets.map(net => `(global_label ${JSON.stringify(net.name)} (shape passive) (at 10 10 0))`).join(" ")}
    ${contract.components.map(component => `(symbol (lib_id ${JSON.stringify(component.symbolLibId)}) (at 20 20 0) (unit 1) (property "Reference" ${JSON.stringify(component.reference)}) (property "Value" ${JSON.stringify(component.value)}) (property "Footprint" ${JSON.stringify(component.footprintLibId)}))`).join(" ")} (no_connect (at 40 30)))`;
  const ncNode = '(node (ref "J1") (pin "4") (pintype "passive+no_connect"))';
  const ncNet = `(net (name ${JSON.stringify(nativeName)}) ${ncNode})`;
  const netlistSource = `(export (design (source "plane-test.kicad_sch") (date "2026-09-16T12:00:00")) (components ${contract.components.map(component => {
    const [lib, part] = component.symbolLibId.split(":");
    return `(comp (ref ${JSON.stringify(component.reference)}) (value ${JSON.stringify(component.value)}) (footprint ${JSON.stringify(component.footprintLibId)}) (libsource (lib ${JSON.stringify(lib)}) (part ${JSON.stringify(part)})))`;
  }).join(" ")}) (nets ${contract.nets.map(net => `(net (name ${JSON.stringify(net.name)}) ${net.endpoints.map(endpoint => `(node (ref ${JSON.stringify(endpoint.reference)}) (pin ${JSON.stringify(endpoint.pin)}) (pintype "passive"))`).join(" ")})`).join(" ")} ${ncNet}))`;
  await writeFile(f.project.pcbPath, pcbSource, "utf8");
  await writeFile(f.project.schematicPath, schematicSource, "utf8");
  let capturedNetlist = netlistSource, libraryCurrent = true, captures = 0, libraryChecks = 0;
  const options: FreshPlaneNetClassOperationOptions = { ...f.options,
    captureNativeNetlist: async () => { captures++; return capturedNetlist; },
    assertLibrarySources: () => { libraryChecks++; if (!libraryCurrent) throw new Error("Fixture physical library source identity changed."); },
  };
  return { ...f, baseOptions: f.options, options, initialAuthority, pcbSource, schematicSource, netlistSource, ncNode, ncNet, nativeName,
    captures: () => captures, libraryChecks: () => libraryChecks, setNetlist: (source: string) => { capturedNetlist = source; },
    changeLibrary: () => { libraryCurrent = false; } };
}

describe("actual V2 plane net-class preparation", () => {
  it("preserves native JSON member order and whitespace when the complete settings already match", async () => {
    const f = await fixture(false, interfaceConstructionBundle());
    await materializeFreshPlaneNetClasses(f.options);
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    const settings = JSON.parse(await readFile(f.proPath, "utf8"));
    settings.net_settings.netclass_patterns = settings.net_settings.netclass_patterns.map((p: { pattern: string; netclass: string }) =>
      ({ netclass: p.netclass, pattern: p.pattern }));
    const nativeText = JSON.stringify(settings, null, 4).replaceAll("\n", "\r\n") + "\r\n";
    await writeFile(f.proPath, nativeText);
    const result = await materializeFreshPlaneNetClasses(f.options);
    expect(result.changed).toBe(false);
    expect(result.preimageProjectSettingsIdentity).toEqual(contentIdentity(nativeText));
    expect(result.projectSettingsIdentity).toEqual(contentIdentity(nativeText));
    expect(await readFile(f.proPath, "utf8")).toBe(nativeText);
    expect(await readFreshPlaneNetClassSemanticAuthority(f.options)).toEqual(authority);
  });
  it.each([undefined, 0.5])("retains opt-in numeric issuance/spacing %s through materialization and refuses drift without rewriting it", async spacing => {
    const draft = { ...planeDividerDraft(), nativeRuleMode: "contract-derived-v1" };
    draft.netClasses.find(c => c.id === "SENSE")!.traceWidthMm = 0.15;
    draft.netClasses.find(c => c.id === "SENSE")!.copperToEdgeMm = 0.25;
    draft.routingConstraints.viaPolicy.drillMm = 0.25;
    const compilation = compilePcbPlaneDesignIntentDraft({ ...draft, routingConstraints: { ...draft.routingConstraints,
      ...(spacing === undefined ? {} : { minimumHoleToHoleMm: spacing }) } }, dependencies);
    expect(compilation.disposition, JSON.stringify(compilation.issues)).toBe("ready");
    const b = createPcbPlaneCompilationBundle({ originalPrompt: "Opt-in native numerical rules", compilation }, dependencies);
    const f = await fixture(false, b), initialRules = await readFile(f.druPath), expected = derivePcbNativeNumericRules(b.contract)!;
    const before = JSON.parse(await readFile(f.proPath, "utf8"));
    expect(before.board.design_settings.rules).toMatchObject(expected.boardRules);
    expect(before.board.design_settings.rules.min_hole_to_hole).toBe(spacing ?? 0.25);
    await materializeFreshPlaneNetClasses(f.options);
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    expect(await verifyFreshPlaneNetClassSemanticAuthority(authority, f.options)).toEqual(authority);
    for (const key of Object.keys(expected.boardRules)) {
      const original = await readFile(f.proPath, "utf8"), changed = JSON.parse(original);
      changed.board.design_settings.rules[key] += 0.001;
      await writeFile(f.proPath, JSON.stringify(changed)); const drifted = await readFile(f.proPath);
      await expect(readFreshPlaneNetClassSemanticAuthority(f.options)).rejects.toThrow(/numeric rule/);
      await expect(materializeFreshPlaneNetClasses(f.options)).rejects.toThrow(/numeric rule/);
      expect(await readFile(f.proPath)).toEqual(drifted);
      await writeFile(f.proPath, original);
    }
    expect(await readFile(f.druPath)).toEqual(initialRules);
  });
  it("preserves pristine and partial functional-only NC preparation without an authored native export", async () => {
    const f=await fixture(false,noConnectBundle());
    const captureNativeNetlist=vi.fn(async()=>{throw new Error("Schematic is intentionally not authored yet.");});
    const options={...f.options,captureNativeNetlist};
    await materializeFreshPlaneNetClasses(options);
    const initial=await readFreshPlaneNetClassSemanticAuthority(options);
    const blank=await readFile(f.project.pcbPath,"utf8"), component=f.compilationBundle.contract.components.find(value=>value.reference==="R1")!;
    const partial=blank.replace(/\)\s*$/u,`(footprint "${component.footprintLibId}" (layer "F.Cu") (at 8 8) (property "Reference" "R1") (property "Value" "${component.value}") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "VIN")))\n)\n`);
    await writeFile(f.project.pcbPath,partial,"utf8");
    expect((await materializeFreshPlaneNetClasses(options)).changed).toBe(false);
    expect(await verifyFreshPlaneNetClassSemanticAuthority(initial,options)).toEqual(initial);
    const allRefsPartial=blank.replace(/\)\s*$/u,f.compilationBundle.contract.components.map(component=>{
      const pin=component.pins.find(pin=>pin.assignment.kind==="net")!,net=pin.assignment.kind==="net"?pin.assignment.net:"";
      return `(footprint "${component.footprintLibId}" (layer "F.Cu") (at 8 8) (property "Reference" "${component.reference}") (property "Value" "${component.value}") (pad "${pin.pin}" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "${net}")))`;
    }).join("\n")+"\n)\n");
    await writeFile(f.project.pcbPath,allRefsPartial,"utf8");
    expect(parseFreshPcbSource(allRefsPartial).footprints).toHaveLength(f.compilationBundle.contract.components.length);
    expect((await materializeFreshPlaneNetClasses(options)).changed).toBe(false);
    expect(await verifyFreshPlaneNetClassSemanticAuthority(initial,options)).toEqual(initial);
    expect(captureNativeNetlist).not.toHaveBeenCalled();
  });

  it("materializes and reads canonical constructed boards without changing stackup, source binding or rules", async () => {
    const f = await fixture(false, interfaceConstructionBundle());
    const paths = [f.project.pcbPath, f.project.markerPath, f.druPath];
    const before = await Promise.all(paths.map(file => readFile(file)));
    expect(() => assertFreshPlaneReferenceCopperScope(before[0]!.toString("utf8"))).not.toThrow();
    const materialization = await materializeFreshPlaneNetClasses(f.options);
    expect(materialization.changed).toBe(true);
    expect(materialization.pcbIdentityAtMaterialization).toEqual(contentIdentity(before[0]!));
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    expect(authority.contractNetAssignments.map(item => item.netName).sort()).toEqual(["DN", "DP", "GND"]);
    expect(await verifyFreshPlaneNetClassSemanticAuthority(authority, f.options)).toEqual(authority);
    expect((await materializeFreshPlaneNetClasses(f.options)).changed).toBe(false);
    expect(await Promise.all(paths.map(file => readFile(file)))).toEqual(before);
    expect(parseFreshPcbStackup(before[0]!.toString("utf8"))).toMatchObject({ status: "explicit", observationsComplete: true });
  });

  it("rejects malformed stackup, nested copper and rogue layer selectors through both construction consumers", async () => {
    const f = await fixture(false, interfaceConstructionBundle());
    await materializeFreshPlaneNetClasses(f.options);
    const original = await readFreshPlaneNetClassSemanticAuthority(f.options);
    const source = await readFile(f.project.pcbPath, "utf8"), newline = source.includes("\r\n") ? "\r\n" : "\n";
    const stack = parseFreshPcbStackup(source).stackupSource!;
    const addStack = (form: string) => source.replace(`(stackup${newline}`, `(stackup${newline}${form}${newline}`);
    const addSetup = (form: string) => source.replace(`(setup${newline}`, `(setup${newline}${form}${newline}`);
    const appendRoot = (form: string) => source.replace(/\)\s*$/u, `${form}${newline})${newline}`);
    const track = '(segment (start 1 1) (end 2 1) (width 0.5) (layer "F.Cu") (net "DP"))';
    const cases = [
      ["unknown stackup form", addStack('(future_stackup_setting 1)')],
      ["nested copper track", addStack(track)],
      ["nested zone", addStack('(zone (net "GND") (layer "B.Cu"))')],
      ["nested copper field", source.replace('(material "fixture laminate")', `(material "fixture laminate" ${track})`)],
      ["rogue stackup layer selector", source.replace('(type "core")', '(type "core") (layer "F.Cu")')],
      ["unknown physical layer", source.replace('(layer "dielectric 1"', '(layer "Mystery.Layer"')],
      ["duplicate stackup", addSetup('(stackup)')],
      ["duplicate setup", appendRoot('(setup)')],
      ["nested setup", addSetup('(setup)')],
      ["stackup outside setup", source.replace(stack, "").replace(/\)\s*$/u, `(property "note" "value" ${stack})${newline})${newline}`)],
      ["setup copper track", addSetup(track)],
      ["setup zone", addSetup('(zone (net "GND") (layer "B.Cu"))')],
      ["setup rogue selector", addSetup('(layer "B.Cu")')],
      ["nested setup rogue selector", addSetup('(note (layers "F.Cu" "B.Cu"))')],
      ["root copper graphic", appendRoot('(gr_line (start 1 1) (end 2 1) (layer "F.Cu"))')],
      ["root ambiguous track layer", appendRoot(track.replace('(layer "F.Cu")', '(layer "F.Cu") (layers "B.Cu")'))],
      ["root rogue pad layer", appendRoot('(pad "1" smd rect (layers "In1.Cu"))')],
    ] as const;
    const retained = await Promise.all([f.proPath, f.project.markerPath, f.druPath].map(file => readFile(file)));
    for (const [name, changed] of cases) {
      expect(changed, name).not.toBe(source);
      expect(() => assertFreshPlaneReferenceCopperScope(changed), name).toThrow();
      await writeFile(f.project.pcbPath, changed);
      await expect(materializeFreshPlaneNetClasses(f.options), name).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(readFreshPlaneNetClassSemanticAuthority(f.options), name).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      await expect(verifyFreshPlaneNetClassSemanticAuthority(original, f.options), name).rejects.toMatchObject({ code: "UNSUPPORTED_PCB" });
      expect(await readFile(f.project.pcbPath, "utf8"), name).toBe(changed);
      expect(await Promise.all([f.proPath, f.project.markerPath, f.druPath].map(file => readFile(file))), name).toEqual(retained);
    }
  });

  it.each([false, true])("materializes authentic V2 classes and verifies original %s-solid rule bytes without a V1 clearance claim", async solid => {
    const f = await fixture(solid);
    const before = await Promise.all([readFile(f.project.pcbPath), readFile(f.project.markerPath), readFile(f.druPath)]);
    const materialization = await materializeFreshPlaneNetClasses(f.options);
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    const rules = createFreshPlaneRules(f.compilationBundle);
    expect(materialization).toMatchObject({ family: "plane-v2", classification: "candidate-configuration", acceptanceEvaluated: false, changed: true,
      bundleIdentity: f.compilationBundle.identity, contractIdentity: f.compilationBundle.contract.identity, planeProjectBindingIdentity: f.project.planeBinding.identity,
      customRulesIdentity: rules.identity, assignmentModel: FRESH_NETCLASS_ASSIGNMENT_MODEL, evaluation: { zones: "not-evaluated", planeClearance: "not-evaluated" } });
    expect(materialization).not.toHaveProperty("genericProjectBindingIdentity");
    expect(authority).toMatchObject({ ruleResolution: { zones: "not-evaluated", planeClearance: "not-evaluated", customRules: "exact-bundle-owned-plane-rules",
      localPadOrFootprintOverrides: "clearance-only-rejected", localThermalOverrides: "not-evaluated", contractNetAssignments: "exclusive" } });
    expect(authority).not.toHaveProperty("acceptanceEvidence");
    expect(authority.kicad).not.toHaveProperty("path");
    const pro = JSON.parse(await readFile(f.proPath, "utf8"));
    expect(pro.net_settings.meta).toEqual({ version: 5 });
    expect(pro.net_settings.netclass_assignments).toEqual({});
    expect(pro.net_settings.netclass_patterns.map((entry: any) => entry.pattern).sort()).toEqual(["^GND$", "^VIN$", "^VOUT$"]);
    for (const definition of authority.netClasses) expect(definition.name).toMatch(new RegExp(`^EVLEDA_${f.compilationBundle.identity.digest.slice(0, 12)}_C0[12]$`));
    expect(pro.net_settings.classes.filter((entry: any) => entry.name.startsWith("EVLEDA_"))).toEqual(authority.netClasses);
    const after = await Promise.all([readFile(f.project.pcbPath), readFile(f.project.markerPath), readFile(f.druPath)]);
    expect(after).toEqual(before);
    expect(after[2]!.toString()).toBe(rules.source);
    if (solid) expect(rules.source).toBe("(version 1)\n");
    else expect(rules.source).toContain("(constraint min_resolved_spokes 2)");
    expect(parseFreshPlaneNetClassMaterialization(structuredClone(materialization))).toEqual(materialization);
    expect(parseFreshPlaneNetClassSemanticAuthority(structuredClone(authority))).toEqual(authority);
    const evidence = createFreshPlaneNetClassPreparationEvidence(materialization, authority);
    expect(parseFreshPlaneNetClassPreparationEvidence(structuredClone(evidence))).toEqual(evidence);
    expect(evidence).toMatchObject({ materializationIdentity: materialization.identity, semanticAuthorityIdentity: authority.identity, customRulesIdentity: rules.identity });
  });

  it("replays unchanged semantics through native-style formatting/null cache and never weakens V1 entry points", async () => {
    const f = await fixture(); const materialization = await materializeFreshPlaneNetClasses(f.options);
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    expect((await materializeFreshPlaneNetClasses(f.options)).changed).toBe(false);
    await editProject(f.proPath, pro => { pro.net_settings.netclass_assignments = null; });
    expect(await verifyFreshPlaneNetClassSemanticAuthority(authority, f.options)).toEqual(authority);
    const evidence = createFreshPlaneNetClassPreparationEvidence(materialization, authority);
    expect(() => parseFreshNetClassSemanticAuthority(authority)).toThrow();
    expect(() => parseFreshNetClassPreparationEvidence(evidence)).toThrow();
    await expect(materializeFreshNetClasses(f.options as never)).rejects.toMatchObject({ code: "UNVERIFIED_PROJECT" });
    await expect(readFreshClearanceEvidence(f.options as never)).rejects.toMatchObject({ code: "UNVERIFIED_PROJECT" });
  });

  it("keeps semantic authority configuration-only after zones exist; it does not certify their local rules or geometry", async () => {
    const f = await fixture(); await materializeFreshPlaneNetClasses(f.options);
    const original = await readFreshPlaneNetClassSemanticAuthority(f.options);
    const pcb = await readFile(f.project.pcbPath, "utf8");
    await writeFile(f.project.pcbPath, pcb.replace(/\)\s*$/u, '(zone (net "GND") (layer "B.Cu") (connect_pads (clearance 0.7)) (fill yes) (polygon (pts (xy 1 1) (xy 20 1) (xy 20 15))))\n)\n'));
    const current = await readFreshPlaneNetClassSemanticAuthority(f.options);
    expect(current).toEqual(original);
    expect(current.ruleResolution).toMatchObject({ zones: "not-evaluated", planeClearance: "not-evaluated" });
    expect(current.acceptanceEvaluated).toBe(false);
  });

  it.each(["missing", "different", "additional"])("rejects %s original owned rule source without repairing or overwriting it", async mode => {
    const f = await fixture(); const proBefore = await readFile(f.proPath);
    if (mode === "missing") await unlink(f.druPath);
    else await writeFile(f.druPath, mode === "different" ? "(version 1)\n" : createFreshPlaneRules(f.compilationBundle).source + '(rule "foreign" (constraint clearance (min 0.1mm)))\n');
    const changed = mode === "missing" ? null : await readFile(f.druPath);
    await expect(materializeFreshPlaneNetClasses(f.options)).rejects.toThrow();
    expect(await readFile(f.proPath)).toEqual(proBefore);
    if (changed !== null) expect(await readFile(f.druPath)).toEqual(changed);
  });

  it.each(["class", "patterns", "derived", "meta"])("rejects %s semantic drift without silently rematerializing it", async kind => {
    const f = await fixture(); await materializeFreshPlaneNetClasses(f.options);
    await editProject(f.proPath, pro => {
      if (kind === "class") pro.net_settings.classes.find((entry: any) => entry.name.startsWith("EVLEDA_")).track_width += 0.1;
      if (kind === "patterns") pro.net_settings.netclass_patterns[0].pattern = "*";
      if (kind === "derived") pro.net_settings.netclass_assignments = { GND: "Default" };
      if (kind === "meta") pro.net_settings.meta.version = 4;
    });
    const changed = await readFile(f.proPath);
    await expect(readFreshPlaneNetClassSemanticAuthority(f.options)).rejects.toThrow();
    await expect(materializeFreshPlaneNetClasses(f.options)).rejects.toThrow();
    expect(await readFile(f.proPath)).toEqual(changed);
  });

  it("rejects cloned bundles/projects and another authenticated bundle before publication", async () => {
    const f = await fixture();
    await expect(materializeFreshPlaneNetClasses({ ...f.options, compilationBundle: structuredClone(f.compilationBundle) })).rejects.toMatchObject({ code: "UNVERIFIED_BUNDLE" });
    await expect(materializeFreshPlaneNetClasses({ ...f.options, project: { ...f.project } })).rejects.toMatchObject({ code: "UNVERIFIED_PROJECT" });
    await expect(materializeFreshPlaneNetClasses({ ...f.options, compilationBundle: bundle("Different actual V2 bundle.") })).rejects.toMatchObject({ code: "UNVERIFIED_BUNDLE" });
  });

  it("rejects rehashed authority escalation, V1 domains, class conflicts and crossed preparation children", async () => {
    const f = await fixture(); const materialization = await materializeFreshPlaneNetClasses(f.options);
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    for (const change of [
      (value: any) => { value.ruleResolution.zones = "rejected"; },
      (value: any) => { value.evaluation.planeClearance = "pass"; },
      (value: any) => { value.acceptanceEvaluated = true; },
      (value: any) => { value.contractIdentity.schemaVersion = "evleda.pcb-design-contract.v1"; },
      (value: any) => { value.contractNetAssignments[1] = { ...value.contractNetAssignments[0] }; },
      (value: any) => { value.netClasses[0].diff_pair_gap = 0.3; },
    ]) {
      const value = structuredClone(authority); change(value);
      expect(() => parseFreshPlaneNetClassSemanticAuthority(rehash(value))).toThrow();
    }
    const changed = structuredClone(materialization) as unknown as Record<string, any>;
    changed.customRulesIdentity = contentIdentity("(version 1)\n");
    changed.identity = canonicalIdentity(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "identity")), changed.schemaVersion);
    expect(() => createFreshPlaneNetClassPreparationEvidence(changed as never, authority)).toThrow("customRulesIdentity");
  });

  it("restores exact project preimage on a post-commit failure and leaves the owned rule source unchanged", async () => {
    const f = await fixture(); const before = await readFile(f.proPath), rules = await readFile(f.druPath);
    vi.stubEnv("EVLEDA_TEST_ONLY_FRESH_CLEARANCE_POST_COMMIT_FAULT", "throw");
    await expect(materializeFreshPlaneNetClasses(f.options)).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
    expect(await readFile(f.proPath)).toEqual(before); expect(await readFile(f.druPath)).toEqual(rules);
  });
});

describe("V2 native NC names remain outside functional net-class assignments", () => {
  it.each([noConnectName, standardNoConnectName])("retains exact native name %s while reproducing blank-board semantic authority", async nativeName => {
    const f = await noConnectFixture(nativeName, true);
    const sourceBefore = await readFile(f.project.pcbPath, "utf8");
    const padsBefore = parseFreshPcbSource(sourceBefore).footprints.flatMap(fp => fp.pads);
    expect(padsBefore.filter(pad => pad.netName === nativeName)).toHaveLength(2);
    const authority = await readFreshPlaneNetClassSemanticAuthority(f.options);
    expect(authority).toEqual(f.initialAuthority);
    expect(authority.contractNetAssignments.map(assignment => assignment.netName).sort()).toEqual(["GND", "VIN", "VOUT"]);
    expect(authority.contractNetAssignments.some(assignment => assignment.netName === nativeName)).toBe(false);
    expect(await verifyFreshPlaneNetClassSemanticAuthority(f.initialAuthority, f.options)).toEqual(f.initialAuthority);
    const materialization = await materializeFreshPlaneNetClasses(f.options);
    expect(materialization.changed).toBe(false);
    expect(materialization.netClasses.flatMap(netClass => netClass.netNames).sort()).toEqual(["GND", "VIN", "VOUT"]);
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(sourceBefore);
    expect(parseFreshPcbSource(await readFile(f.project.pcbPath, "utf8")).footprints.flatMap(fp => fp.pads)).toEqual(padsBefore);
    expect(f.captures()).toBeGreaterThan(0); expect(f.libraryChecks()).toBeGreaterThan(1);
    const project = JSON.parse(await readFile(f.proPath, "utf8"));
    expect(project.net_settings.netclass_patterns.map((entry: any) => entry.pattern).sort()).toEqual(["^GND$", "^VIN$", "^VOUT$"]);
  });

  it("revalidates the original configuration-only authority after a plane fill exists", async () => {
    const f = await noConnectFixture();
    const filled = f.pcbSource.replace(/\)\s*$/u, '(zone (net "GND") (layer "B.Cu") (fill yes) (polygon (pts (xy 1 1) (xy 20 1) (xy 20 15))))\n)\n');
    await writeFile(f.project.pcbPath, filled, "utf8");
    expect(await verifyFreshPlaneNetClassSemanticAuthority(f.initialAuthority, f.options)).toEqual(f.initialAuthority);
    expect((await readFreshPlaneNetClassSemanticAuthority(f.options)).ruleResolution).toMatchObject({ zones: "not-evaluated", planeClearance: "not-evaluated" });
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(filled);
  });

  it.each([noConnectName, standardNoConnectName])("fails closed for %s without host native-netlist capture", async nativeName => {
    const f = await noConnectFixture(nativeName), before = await readFile(f.proPath, "utf8");
    await expect(readFreshPlaneNetClassSemanticAuthority(f.baseOptions)).rejects.toThrow();
    await expect(verifyFreshPlaneNetClassSemanticAuthority(f.initialAuthority, f.baseOptions)).rejects.toThrow();
    await expect(materializeFreshPlaneNetClasses(f.baseOptions)).rejects.toThrow();
    expect(f.captures()).toBe(0);
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(f.pcbSource);
    expect(await readFile(f.proPath, "utf8")).toBe(before);
  });

  it.each(["untyped", "wrong endpoint", "multiple endpoints", "duplicate endpoint", "functional parity", "component identity"])("rejects %s native export instead of admitting the name", async mutation => {
    const f = await noConnectFixture(standardNoConnectName);
    const changed = mutation === "untyped" ? f.netlistSource.replace("passive+no_connect", "passive")
      : mutation === "wrong endpoint" ? f.netlistSource.replace(f.ncNode, f.ncNode.replace('(pin "4")', '(pin "9")'))
      : mutation === "multiple endpoints" ? f.netlistSource.replace(f.ncNode, f.ncNode + ' (node (ref "J1") (pin "9") (pintype "no_connect"))')
      : mutation === "duplicate endpoint" ? f.netlistSource.replace(f.ncNode, `${f.ncNode} ${f.ncNode}`)
      : mutation === "functional parity" ? f.netlistSource.replace('(name "VIN")', '(name "OTHER")')
      : f.netlistSource.replace('(value "DIVIDER_IO")', '(value "WRONG")');
    expect(changed).not.toBe(f.netlistSource); f.setNetlist(changed);
    await expect(readFreshPlaneNetClassSemanticAuthority(f.options)).rejects.toThrow();
    await expect(verifyFreshPlaneNetClassSemanticAuthority(f.initialAuthority, f.options)).rejects.toThrow();
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(f.pcbSource);
  });

  it.each(["wrong name", "prefix impostor", "wrong member", "missing member", "foreign terminal", "mixed repeated member"])("rejects PCB %s despite a complete matching native export", async mutation => {
    const f = await noConnectFixture(noConnectName, mutation === "mixed repeated member");
    const board = parseFreshPcbSource(f.pcbSource), ncPad = board.footprints.find(fp => fp.reference === "J1")!.pads.find(pad => pad.number === "4")!;
    const changed = mutation === "wrong name" ? f.pcbSource.replace(JSON.stringify(f.nativeName), '"OTHER_NC"')
      : mutation === "prefix impostor" ? f.pcbSource.replace(JSON.stringify(f.nativeName), JSON.stringify(standardNoConnectName))
      : mutation === "wrong member" ? f.pcbSource.replace(ncPad.physical.source, ncPad.physical.source.replace('(pad "4"', '(pad "9"'))
      : mutation === "missing member" ? f.pcbSource.replace(ncPad.physical.source, "")
      : mutation === "foreign terminal" ? f.pcbSource.replace('(net "VIN")', `(net ${JSON.stringify(f.nativeName)})`)
      : f.pcbSource.replace(ncPad.physical.source, ncPad.physical.source.replace(JSON.stringify(f.nativeName), '"GND"'));
    expect(changed).not.toBe(f.pcbSource); await writeFile(f.project.pcbPath, changed, "utf8");
    await expect(readFreshPlaneNetClassSemanticAuthority(f.options)).rejects.toThrow();
    await expect(materializeFreshPlaneNetClasses(f.options)).rejects.toThrow();
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(changed);
  });

  it.each([
    ["track", `(segment (start 1 1) (end 2 2) (width 0.25) (layer "F.Cu") (net ${JSON.stringify(noConnectName)}))`],
    ["via", `(via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${JSON.stringify(noConnectName)}))`],
    ["zone", `(zone (net ${JSON.stringify(noConnectName)}) (layer "B.Cu") (fill yes) (polygon (pts (xy 1 1) (xy 20 1) (xy 20 15))))`],
  ])("rejects NC %s copper even though plane zone rules are otherwise outside semantic scope", async (_label, copper) => {
    const f = await noConnectFixture(), changed = f.pcbSource.replace(/\)\s*$/u, `${copper}\n)\n`);
    await writeFile(f.project.pcbPath, changed, "utf8");
    await expect(readFreshPlaneNetClassSemanticAuthority(f.options)).rejects.toThrow();
    await expect(verifyFreshPlaneNetClassSemanticAuthority(f.initialAuthority, f.options)).rejects.toThrow();
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(changed);
  });

  it.each(["schematic", "project", "rules", "symbol table", "footprint table", "marker", "PCB", "new library file"])("rejects %s drift during native export without overwriting it", async mutation => {
    const f = await noConnectFixture();
    const changedPath = mutation === "schematic" ? f.project.schematicPath : mutation === "project" ? f.proPath : mutation === "rules" ? f.druPath
      : mutation === "symbol table" ? path.join(f.project.projectPath, "sym-lib-table") : mutation === "footprint table" ? path.join(f.project.projectPath, "fp-lib-table")
      : mutation === "marker" ? f.project.markerPath : mutation === "PCB" ? f.project.pcbPath : path.join(f.project.projectPath, "introduced.kicad_sym");
    const changedSource = mutation === "new library file" ? '(kicad_symbol_lib (version 20241209) (generator "fixture"))\n' : (await readFile(changedPath, "utf8")) + "\n";
    const options: FreshPlaneNetClassOperationOptions = { ...f.options, captureNativeNetlist: async () => {
      const exported = await f.options.captureNativeNetlist!();
      await writeFile(changedPath, changedSource, "utf8"); return exported;
    } };
    await expect(readFreshPlaneNetClassSemanticAuthority(options)).rejects.toThrow();
    expect(f.captures()).toBeGreaterThan(0);
    expect(await readFile(changedPath, "utf8")).toBe(changedSource);
  });

  it("rechecks current library source authority after the native export returns", async () => {
    const f = await noConnectFixture();
    const options: FreshPlaneNetClassOperationOptions = { ...f.options, captureNativeNetlist: async () => {
      const exported = await f.options.captureNativeNetlist!(); f.changeLibrary(); return exported;
    } };
    await expect(readFreshPlaneNetClassSemanticAuthority(options)).rejects.toThrow(/library source identity changed/iu);
    expect(f.captures()).toBeGreaterThan(0); expect(f.libraryChecks()).toBeGreaterThan(1);
    expect(await readFile(f.project.pcbPath, "utf8")).toBe(f.pcbSource);
  });
});

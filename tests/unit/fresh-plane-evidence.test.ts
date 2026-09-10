import { beforeAll, describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createSavedFreshPlaneEvidence, isSavedFreshPlaneEvidence, assertSavedFreshPlaneEvidenceCurrent,
  type SavedFreshPlaneCurrentIdentities } from "../../src/harness/fresh-plane-evidence.js";
import { validateFreshPlaneLiteralStageObservation, validateFreshPlaneStageObservation } from "../../src/harness/fresh-plane-stage-observation.js";
import { prepareFreshPlaneMutation } from "../../src/harness/fresh-plane-mutation.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { planeStageObservationFixture } from "../helpers/plane-stage-observation-fixture.js";
import { withNativePadFixtureIds } from "../helpers/native-pad-observation-fixture.js";

const source = withNativePadFixtureIds(`(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (footprint "Test:X" (layer "F.Cu") (at 2 2) (property "Reference" "J1") (property "Value" "TEST")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND"))))\n`);
function bundle(prompt = "Synthetic offline saved plane evidence fixture.") {
  const dependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbPlaneDesignIntentDraft(planeDividerDraft(), dependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ compilation, originalPrompt: prompt }, dependencies);
}
async function fixture() {
  const compilationBundle = bundle(), prepared = prepareFreshPlaneMutation({ compilationBundle, beforePcbSource: source, operation: "create" });
  const receipt = await planeStageObservationFixture({ beforePcbSource: source, mutation: prepared.mutation });
  const stage = validateFreshPlaneStageObservation(receipt.receipt, { ...receipt, prepared });
  const input = { compilationBundle, stage, savedPcbSource: receipt.stagedSource,
    projectBindingIdentity: canonicalIdentity({ project: "offline-owned-project" }, "evleda.pcb-agent-plane-fresh-binding.v1"),
    sourceScopeIdentity: receipt.padExpected.scopeIdentity, projectSettingsIdentity: contentIdentity('{"net_settings":{}}\n'), rulesIdentity: prepared.rulesIdentity };
  return { ...receipt, input, prepared };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => { f = await fixture(); });
const current = (evidence: ReturnType<typeof createSavedFreshPlaneEvidence>): SavedFreshPlaneCurrentIdentities => ({
  bundleIdentity: evidence.bundleIdentity, projectBindingIdentity: evidence.projectBindingIdentity, sourceScopeIdentity: evidence.sourceScopeIdentity,
  savedPcbIdentity: evidence.savedPcbIdentity, projectSettingsIdentity: evidence.projectSettingsIdentity, rulesIdentity: evidence.rulesIdentity,
});
const changed = (digest: string) => (digest[0] === "0" ? "1" : "0") + digest.slice(1);

describe("current-session saved native plane evidence", () => {
  it("brands an authentic V2 stage only after saved-source equivalence and captures all exact identities", () => {
    const evidence = createSavedFreshPlaneEvidence(f.input);
    expect(isSavedFreshPlaneEvidence(evidence)).toBe(true);
    expect(evidence).toMatchObject({ schemaVersion: "evleda.saved-fresh-plane-evidence.v1", authority: "host-validated-stage-and-mandatory-save-current-session",
      bundleIdentity: f.input.compilationBundle.identity, contractIdentity: f.input.compilationBundle.contract.identity,
      verificationPlanIdentity: f.input.compilationBundle.verificationPlan.identity, projectBindingIdentity: f.input.projectBindingIdentity,
      sourceScopeIdentity: f.input.sourceScopeIdentity, projectSettingsIdentity: f.input.projectSettingsIdentity, rulesIdentity: f.prepared.rulesIdentity,
      savedPcbIdentity: contentIdentity(f.stagedSource) });
    expect(evidence.stage).toBe(f.input.stage); expect(evidence.stage.nativeFilledZones).toHaveLength(1);
    expect(evidence.stage.nativeFilledZones[0]!.raw).toEqual(f.stagedZoneProto);
    expect(evidence.stage.savedAuthorityMinted).toBe(false); expect(evidence).not.toHaveProperty("acceptanceEvaluated");
    expect(() => assertSavedFreshPlaneEvidenceCurrent(evidence, current(evidence))).not.toThrow();
    const { identity, ...body } = evidence; expect(identity).toEqual(canonicalIdentity(body, evidence.schemaVersion));
    expect(Object.isFrozen(evidence)).toBe(true); expect(Object.isFrozen(evidence.projectBindingIdentity)).toBe(true);
    expect(Object.isFrozen(evidence.stage.nativeFilledZones[0]!.raw)).toBe(true);
  });

  it("allows pinned serializer layout/CRLF differences while retaining exact saved bytes", () => {
    const savedPcbSource = f.stagedSource.replaceAll("\n", "\r\n").replace("(general (thickness 1.6))", "(general\t(thickness 1.6))");
    const evidence = createSavedFreshPlaneEvidence({ ...f.input, savedPcbSource });
    expect(evidence.savedPcbIdentity).toEqual(contentIdentity(savedPcbSource));
    expect(evidence.savedPcbIdentity).not.toEqual(contentIdentity(f.stagedSource));
    expect(() => assertSavedFreshPlaneEvidenceCurrent(evidence, { ...current(evidence), savedPcbIdentity: contentIdentity(f.stagedSource) })).toThrow("savedPcbIdentity");
  });

  it("allows a real validated UPDATE epoch whose saved source bytes do not change", async () => {
    const prepared = prepareFreshPlaneMutation({ compilationBundle: f.input.compilationBundle, beforePcbSource: f.stagedSource,
      operation: "update", zoneId: f.input.stage.targetZoneUuid });
    const update = await planeStageObservationFixture({ beforePcbSource: f.stagedSource, mutation: prepared.mutation, beforeZoneProtos: [f.stagedZoneProto] });
    const stage = validateFreshPlaneStageObservation(update.receipt, { ...update, prepared });
    expect(update.stagedSource).toBe(f.stagedSource);
    const evidence = createSavedFreshPlaneEvidence({ ...f.input, stage, savedPcbSource: update.stagedSource });
    expect(evidence.savedPcbIdentity).toEqual(stage.savedSourceIdentity);
    expect(isSavedFreshPlaneEvidence(evidence)).toBe(true);
  });

  it.each(["structuredClone", "JSON", "spread"] as const)("rejects a %s evidence copy as historical/unbranded", mode => {
    const evidence = createSavedFreshPlaneEvidence(f.input);
    const copy = mode === "structuredClone" ? structuredClone(evidence) : mode === "JSON" ? JSON.parse(JSON.stringify(evidence)) : { ...evidence };
    expect(isSavedFreshPlaneEvidence(copy)).toBe(false);
    expect(() => assertSavedFreshPlaneEvidenceCurrent(copy, current(evidence))).toThrow("historical/serialized");
  });

  it.each([null, undefined, {}, [], "saved", 1])("does not confer authority on an arbitrary value", value => {
    expect(isSavedFreshPlaneEvidence(value)).toBe(false);
  });

  it("rejects cloned stages, cloned bundles, literal-only validation and another authentic bundle", () => {
    expect(() => createSavedFreshPlaneEvidence({ ...f.input, stage: structuredClone(f.input.stage) })).toThrow("authenticated V2 stage");
    expect(() => createSavedFreshPlaneEvidence({ ...f.input, compilationBundle: structuredClone(f.input.compilationBundle) })).toThrow("authenticated V2 stage");
    const literal = validateFreshPlaneLiteralStageObservation(f.receipt, f);
    expect(() => createSavedFreshPlaneEvidence({ ...f.input, stage: literal })).toThrow("authenticated V2 stage");
    expect(() => createSavedFreshPlaneEvidence({ ...f.input, compilationBundle: bundle("Another authentic bundle identity.") })).toThrow("authenticated V2 stage");
  });

  it.each([
    ["preimage", () => source],
    ["geometry", () => f.stagedSource.replace("(at 2 2)", "(at 3 2)")],
    ["quoted text", () => f.stagedSource.replace('"TEST"', '"TEST "')],
    ["extra source form", () => f.stagedSource.replace("(general", "(future_mode yes) (general")],
    ["malformed", () => f.stagedSource + ")"],
    ["EOF policy", () => f.stagedSource + "\n"],
  ] as const)("rejects %s save mismatch", (_name, savedSource) => {
    expect(() => createSavedFreshPlaneEvidence({ ...f.input, savedPcbSource: savedSource() })).toThrow();
  });

  it("rejects a different exact owned rules content identity at issuance", () => {
    expect(() => createSavedFreshPlaneEvidence({ ...f.input, rulesIdentity: contentIdentity("changed rules") })).toThrow("authenticated V2 stage");
  });

  it.each(["bundleIdentity", "projectBindingIdentity", "sourceScopeIdentity", "savedPcbIdentity", "projectSettingsIdentity", "rulesIdentity"] as const)(
    "rejects current %s drift", key => {
      const evidence = createSavedFreshPlaneEvidence(f.input);
      const now = { ...current(evidence), [key]: { ...evidence[key], digest: changed(evidence[key].digest) } };
      expect(() => assertSavedFreshPlaneEvidenceCurrent(evidence, now)).toThrow(`stale: ${key}`);
    });

  it("requires complete canonical metadata and byte sizes, not matching digests alone", () => {
    const evidence = createSavedFreshPlaneEvidence(f.input);
    expect(() => assertSavedFreshPlaneEvidenceCurrent(evidence, { ...current(evidence), projectBindingIdentity: { ...evidence.projectBindingIdentity, schemaVersion: "different.v1" } })).toThrow("stale: projectBindingIdentity");
    expect(() => assertSavedFreshPlaneEvidenceCurrent(evidence, { ...current(evidence), savedPcbIdentity: { ...evidence.savedPcbIdentity, size: evidence.savedPcbIdentity.size + 1 } })).toThrow("stale: savedPcbIdentity");
    const missing = structuredClone(current(evidence)) as any; delete missing.rulesIdentity;
    expect(() => assertSavedFreshPlaneEvidenceCurrent(evidence, missing)).toThrow("every exact identity");
    expect(() => assertSavedFreshPlaneEvidenceCurrent(evidence, { ...current(evidence), untrustedExtra: true } as any)).toThrow("every exact identity");
  });

  it.each([
    ["projectBindingIdentity", { algorithm: "sha1" }],
    ["sourceScopeIdentity", { digest: "abc" }],
    ["sourceScopeIdentity", { digest: "A".repeat(64) }],
    ["sourceScopeIdentity", { schemaVersion: "" }],
    ["sourceScopeIdentity", { canonicalizationVersion: "different" }],
    ["projectSettingsIdentity", { size: -1 }],
    ["projectSettingsIdentity", { size: 1.5 }],
    ["projectSettingsIdentity", { size: Number.MAX_SAFE_INTEGER + 1 }],
    ["projectSettingsIdentity", { ignoredExtra: true }],
    ["rulesIdentity", { algorithm: "sha512" }],
  ] as const)("rejects malformed issuance identity %s %j", (key, change) => {
    const input = { ...f.input, [key]: { ...f.input[key], ...change } };
    expect(() => createSavedFreshPlaneEvidence(input as typeof f.input)).toThrow();
  });

  it("rejects getter/proxy identity data without invoking its getter", () => {
    let issuanceGetterCalled = false;
    const getter = Object.defineProperty({ ...f.input.projectBindingIdentity }, "digest", { enumerable: true, get() { issuanceGetterCalled = true; return f.input.projectBindingIdentity.digest; } });
    expect(() => createSavedFreshPlaneEvidence({ ...f.input, projectBindingIdentity: getter })).toThrow();
    expect(issuanceGetterCalled).toBe(false);
    const proxy = new Proxy(f.input.projectSettingsIdentity, {});
    expect(() => createSavedFreshPlaneEvidence({ ...f.input, projectSettingsIdentity: proxy })).toThrow();
    const evidence = createSavedFreshPlaneEvidence(f.input), now = current(evidence);
    let called = false;
    Object.defineProperty(now, "savedPcbIdentity", { enumerable: true, get() { called = true; return evidence.savedPcbIdentity; } });
    expect(() => assertSavedFreshPlaneEvidenceCurrent(evidence, now)).toThrow(); expect(called).toBe(false);
  });

  it("snapshots identities without retaining or freezing caller-owned objects", () => {
    const projectBindingIdentity = structuredClone(f.input.projectBindingIdentity), projectSettingsIdentity = structuredClone(f.input.projectSettingsIdentity);
    const evidence = createSavedFreshPlaneEvidence({ ...f.input, projectBindingIdentity, projectSettingsIdentity });
    expect(evidence.projectBindingIdentity).not.toBe(projectBindingIdentity); expect(evidence.projectSettingsIdentity).not.toBe(projectSettingsIdentity);
    expect(Object.isFrozen(projectBindingIdentity)).toBe(false); expect(Object.isFrozen(projectSettingsIdentity)).toBe(false);
    (projectBindingIdentity as any).digest = "0".repeat(64); (projectSettingsIdentity as any).size++;
    expect(evidence.projectBindingIdentity).toEqual(f.input.projectBindingIdentity); expect(evidence.projectSettingsIdentity).toEqual(f.input.projectSettingsIdentity);
    expect(() => assertSavedFreshPlaneEvidenceCurrent(evidence, structuredClone(current(evidence)))).not.toThrow();
  });
});

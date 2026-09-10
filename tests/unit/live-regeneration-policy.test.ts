import { describe, expect, it } from "vitest";
import {
  bundleExportReplaySchema,
  bundleExportReplayV1Schema,
  bundleExportReplayV2Schema,
  bundleExportResultSchema,
  bundleManifestSchema,
  currentBundleExportResultSchema,
  currentStoredBundleExportResultSchema,
  legacyBundleExportResultSchema,
  legacyBundleManifestSchema,
  legacyStoredBundleExportResultSchema,
  LIVE_REGENERATION_POLICY,
  LIVE_REGENERATION_POLICY_IDENTITY,
  LIVE_REGENERATION_POLICY_IDENTITY_SCHEMA_VERSION,
  liveRegenerationPolicyIdentitySchema,
  liveRegenerationPolicySchema,
  storedBundleExportResultSchema
} from "../../src/contracts/results.js";
import { canonicalIdentity } from "../../src/core/canonical.js";

const canonicalIdentityFixture = (schemaVersion: string, digit: string) => ({
  algorithm: "sha256" as const,
  digest: digit.repeat(64),
  schemaVersion,
  canonicalizationVersion: "evleda-c14n-json-v1" as const
});

const contentIdentityFixture = (digit: string, size = 0) => ({
  algorithm: "sha256" as const,
  digest: digit.repeat(64),
  size
});

const revisionManifest = () => canonicalIdentityFixture("evleda.design-revision.v1", "a");
const evidenceRoot = () => canonicalIdentityFixture("evleda.evidence-root.v1", "b");
const policyIdentity = () => ({ ...LIVE_REGENERATION_POLICY_IDENTITY });
const bundler = (current = true) => ({
  name: "evleda-deterministic-bundler",
  version: "0.1.0",
  adapter: "evleda" as const,
  capabilityProfile: current ? "deterministic-zip-v3" : "deterministic-zip-v2"
});

const currentExactInputs = () => [
  revisionManifest(),
  evidenceRoot(),
  policyIdentity()
] as const;

const legacyExactInputs = () => [revisionManifest(), evidenceRoot()] as const;

const bundleGeneratedArtifact = (current: boolean) => ({
  path: "README.md",
  logicalName: "bundle/README.md",
  mediaType: "text/markdown; charset=utf-8",
  identity: contentIdentityFixture("d", 12),
  stage: "manufacturing_package" as const,
  validationStatus: "pass" as const,
  sourceArtifactId: "bundle_artifact_policy",
  sourceKind: "bundle_generated" as const,
  sourceDesignRevisionId: "revision_policy",
  projectId: "project_policy",
  runId: "run_policy",
  designRevisionId: "revision_policy",
  exactInputs: current ? currentExactInputs() : legacyExactInputs(),
  derivedFrom: [],
  tool: bundler(current),
  unresolvedAssumptions: [],
  lifecycle: "candidate" as const,
  createdAt: null,
  staleAt: null,
  generationRole: "readme" as const
});

const currentManifestFixture = () => ({
  schemaVersion: "evleda.bundle-manifest.v3" as const,
  canonicalizationVersion: "evleda-c14n-json-v1" as const,
  bundleKind: "candidate" as const,
  lifecycle: "candidate" as const,
  projectId: "project_policy",
  runId: "run_policy",
  designRevisionId: "revision_policy",
  designRevisionOrdinal: 1,
  revisionManifest: revisionManifest(),
  revisionRecordPath: "provenance/revision.json" as const,
  evidenceRoot: evidenceRoot(),
  evidenceInventoryPath: "evidence/evidence.json" as const,
  warning: "CANDIDATE — NOT FOR MANUFACTURING",
  artifacts: [bundleGeneratedArtifact(true)],
  toolchain: [bundler()],
  unresolvedAssumptions: [],
  exactInputs: currentExactInputs(),
  liveRegenerationPolicy: { ...LIVE_REGENERATION_POLICY },
  liveRegenerationPolicyIdentity: policyIdentity()
});

const legacyManifestFixture = () => ({
  schemaVersion: "evleda.bundle-manifest.v2" as const,
  canonicalizationVersion: "evleda-c14n-json-v1" as const,
  bundleKind: "candidate" as const,
  lifecycle: "candidate" as const,
  projectId: "project_policy",
  runId: "run_policy",
  designRevisionId: "revision_policy",
  designRevisionOrdinal: 1,
  revisionManifest: revisionManifest(),
  revisionRecordPath: "provenance/revision.json" as const,
  evidenceRoot: evidenceRoot(),
  evidenceInventoryPath: "evidence/evidence.json" as const,
  warning: "CANDIDATE — NOT FOR MANUFACTURING",
  artifacts: [bundleGeneratedArtifact(false)],
  toolchain: [bundler(false)],
  unresolvedAssumptions: []
});

const currentResultFixture = () => {
  const manifest = currentManifestFixture();
  return {
    projectId: manifest.projectId,
    runId: manifest.runId,
    designRevisionId: manifest.designRevisionId,
    workflowStage: "manufacturing_package" as const,
    fileName: "candidate.zip",
    mediaType: "application/zip" as const,
    identity: contentIdentityFixture("c"),
    bytesBase64: "",
    manifest,
    exactInputs: currentExactInputs(),
    tool: bundler(),
    validationStatus: "pass" as const,
    unresolvedAssumptions: [],
    lifecycle: "candidate" as const,
    liveRegenerationPolicy: { ...LIVE_REGENERATION_POLICY },
    liveRegenerationPolicyIdentity: policyIdentity()
  };
};

const legacyResultFixture = () => {
  const manifest = legacyManifestFixture();
  return {
    projectId: manifest.projectId,
    runId: manifest.runId,
    designRevisionId: manifest.designRevisionId,
    workflowStage: "manufacturing_package" as const,
    fileName: "candidate.zip",
    mediaType: "application/zip" as const,
    identity: contentIdentityFixture("c"),
    bytesBase64: "",
    manifest,
    exactInputs: legacyExactInputs(),
    tool: bundler(false),
    validationStatus: "pass" as const,
    unresolvedAssumptions: [],
    lifecycle: "candidate" as const
  };
};

const withoutBytes = <Result extends { readonly bytesBase64: string }>(result: Result) => {
  const { bytesBase64: _bytesBase64, ...stored } = result;
  return stored;
};

describe("live model/research regeneration policy", () => {
  it("pins the explicit traceable policy and its canonical identity", () => {
    expect(liveRegenerationPolicySchema.parse(LIVE_REGENERATION_POLICY)).toStrictEqual({
      scope: "live_model_or_research",
      claim: "traceable",
      reproducible: false
    });
    expect(LIVE_REGENERATION_POLICY_IDENTITY_SCHEMA_VERSION).toBe(
      "evleda.live-regeneration-policy.v1"
    );
    expect(LIVE_REGENERATION_POLICY_IDENTITY).toStrictEqual(
      canonicalIdentity(
        LIVE_REGENERATION_POLICY,
        LIVE_REGENERATION_POLICY_IDENTITY_SCHEMA_VERSION
      )
    );
    expect(
      liveRegenerationPolicyIdentitySchema.parse(LIVE_REGENERATION_POLICY_IDENTITY)
    ).toStrictEqual(LIVE_REGENERATION_POLICY_IDENTITY);

    for (const invalid of [
      { scope: "live_model_or_research", claim: "reproducible", reproducible: true },
      { scope: "live_model_or_research", claim: "traceable", reproducible: true },
      { scope: "live_model", claim: "traceable", reproducible: false },
      { ...LIVE_REGENERATION_POLICY, deterministic: true }
    ]) {
      expect(liveRegenerationPolicySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts current v3 only with both policy copies, their identity, and ordered inputs", () => {
    const result = currentResultFixture();

    expect(bundleManifestSchema.parse(result.manifest)).toStrictEqual(result.manifest);
    expect(currentBundleExportResultSchema.parse(result)).toStrictEqual(result);
    expect(bundleExportResultSchema.parse(result)).toStrictEqual(result);
    expect(result.exactInputs).toStrictEqual([
      result.manifest.revisionManifest,
      result.manifest.evidenceRoot,
      result.manifest.liveRegenerationPolicyIdentity
    ]);
    expect(result.manifest.exactInputs).toStrictEqual(result.exactInputs);
    expect(result.manifest.artifacts[0]!.exactInputs).toStrictEqual(result.exactInputs);
  });

  it("fails closed on current policy or identity tampering", () => {
    const cases: Record<string, unknown>[] = [];

    const missingResultPolicy = structuredClone(currentResultFixture()) as Record<string, unknown>;
    delete missingResultPolicy.liveRegenerationPolicy;
    cases.push(missingResultPolicy);

    const missingManifestIdentity = structuredClone(currentResultFixture()) as Record<string, any>;
    delete missingManifestIdentity.manifest.liveRegenerationPolicyIdentity;
    cases.push(missingManifestIdentity);

    const reproducible = structuredClone(currentResultFixture()) as Record<string, any>;
    reproducible.liveRegenerationPolicy.reproducible = true;
    cases.push(reproducible);

    const resultIdentityTamper = structuredClone(currentResultFixture()) as Record<string, any>;
    resultIdentityTamper.liveRegenerationPolicyIdentity.digest = "e".repeat(64);
    cases.push(resultIdentityTamper);

    const manifestIdentityTamper = structuredClone(currentResultFixture()) as Record<string, any>;
    manifestIdentityTamper.manifest.liveRegenerationPolicyIdentity.digest = "e".repeat(64);
    cases.push(manifestIdentityTamper);

    for (const candidate of cases) {
      expect(currentBundleExportResultSchema.safeParse(candidate).success).toBe(false);
      expect(bundleExportResultSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects reordered, omitted, or duplicated policy bindings", () => {
    const reorderedResult = structuredClone(currentResultFixture()) as Record<string, any>;
    [reorderedResult.exactInputs[1], reorderedResult.exactInputs[2]] = [
      reorderedResult.exactInputs[2],
      reorderedResult.exactInputs[1]
    ];

    const omittedResult = structuredClone(currentResultFixture()) as Record<string, any>;
    omittedResult.exactInputs = omittedResult.exactInputs.slice(0, 2);

    const reorderedManifest = structuredClone(currentResultFixture()) as Record<string, any>;
    [reorderedManifest.manifest.exactInputs[0], reorderedManifest.manifest.exactInputs[2]] = [
      reorderedManifest.manifest.exactInputs[2],
      reorderedManifest.manifest.exactInputs[0]
    ];

    const omittedManifest = structuredClone(currentResultFixture()) as Record<string, any>;
    omittedManifest.manifest.exactInputs = omittedManifest.manifest.exactInputs.slice(0, 2);

    const duplicatedManifest = structuredClone(currentResultFixture()) as Record<string, any>;
    duplicatedManifest.manifest.exactInputs.push(
      duplicatedManifest.manifest.liveRegenerationPolicyIdentity
    );

    const duplicatedArtifactBinding = structuredClone(currentResultFixture()) as Record<string, any>;
    duplicatedArtifactBinding.manifest.artifacts[0].exactInputs = [
      ...duplicatedArtifactBinding.manifest.artifacts[0].exactInputs,
      duplicatedArtifactBinding.manifest.liveRegenerationPolicyIdentity
    ];

    const reorderedArtifactBinding = structuredClone(currentResultFixture()) as Record<string, any>;
    [
      reorderedArtifactBinding.manifest.artifacts[0].exactInputs[0],
      reorderedArtifactBinding.manifest.artifacts[0].exactInputs[2]
    ] = [
      reorderedArtifactBinding.manifest.artifacts[0].exactInputs[2],
      reorderedArtifactBinding.manifest.artifacts[0].exactInputs[0]
    ];

    for (const candidate of [
      reorderedResult,
      omittedResult,
      reorderedManifest,
      omittedManifest,
      duplicatedManifest,
      duplicatedArtifactBinding,
      reorderedArtifactBinding
    ]) {
      expect(currentBundleExportResultSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("preserves the original strict unlabeled v2 result as explicit legacy compatibility", () => {
    const legacy = legacyResultFixture();

    expect(legacyBundleManifestSchema.parse(legacy.manifest)).toStrictEqual(legacy.manifest);
    expect(legacyBundleExportResultSchema.parse(legacy)).toStrictEqual(legacy);
    expect(bundleExportResultSchema.parse(legacy)).toStrictEqual(legacy);
    expect(currentBundleExportResultSchema.safeParse(legacy).success).toBe(false);
    expect(legacy.exactInputs).toStrictEqual([
      legacy.manifest.revisionManifest,
      legacy.manifest.evidenceRoot
    ]);
    expect(legacy.manifest.artifacts[0]!.exactInputs).toStrictEqual(legacy.exactInputs);
  });

  it("does not smuggle current policy fields into legacy v2 or legacy shape into v3", () => {
    const labeledLegacy = structuredClone(legacyResultFixture()) as Record<string, any>;
    labeledLegacy.liveRegenerationPolicy = { ...LIVE_REGENERATION_POLICY };
    labeledLegacy.liveRegenerationPolicyIdentity = policyIdentity();
    labeledLegacy.manifest.liveRegenerationPolicy = { ...LIVE_REGENERATION_POLICY };
    labeledLegacy.manifest.liveRegenerationPolicyIdentity = policyIdentity();
    labeledLegacy.exactInputs.push(policyIdentity());
    labeledLegacy.manifest.artifacts[0].exactInputs.push(policyIdentity());

    const unlabeledCurrent = structuredClone(currentResultFixture()) as Record<string, any>;
    delete unlabeledCurrent.liveRegenerationPolicy;
    delete unlabeledCurrent.liveRegenerationPolicyIdentity;
    delete unlabeledCurrent.manifest.liveRegenerationPolicy;
    delete unlabeledCurrent.manifest.liveRegenerationPolicyIdentity;
    unlabeledCurrent.exactInputs = unlabeledCurrent.exactInputs.slice(0, 2);
    unlabeledCurrent.manifest.artifacts[0].exactInputs =
      unlabeledCurrent.manifest.artifacts[0].exactInputs.slice(0, 2);

    expect(legacyBundleExportResultSchema.safeParse(labeledLegacy).success).toBe(false);
    expect(bundleExportResultSchema.safeParse(labeledLegacy).success).toBe(false);
    expect(currentBundleExportResultSchema.safeParse(unlabeledCurrent).success).toBe(false);
    expect(bundleExportResultSchema.safeParse(unlabeledCurrent).success).toBe(false);
  });

  it("pins replay v1 to manifest v2/zip2 and replay v2 to manifest v3/zip3 without upcasting", () => {
    const currentStored = withoutBytes(currentResultFixture());
    const legacyStored = withoutBytes(legacyResultFixture());
    const currentReplay = {
      schemaVersion: "evleda.bundle-export-replay.v2" as const,
      result: currentStored
    };
    const legacyReplay = {
      schemaVersion: "evleda.bundle-export-replay.v1" as const,
      result: legacyStored
    };

    expect(currentStoredBundleExportResultSchema.parse(currentStored)).toStrictEqual(currentStored);
    expect(legacyStoredBundleExportResultSchema.parse(legacyStored)).toStrictEqual(legacyStored);
    expect(storedBundleExportResultSchema.parse(currentStored)).toStrictEqual(currentStored);
    expect(storedBundleExportResultSchema.parse(legacyStored)).toStrictEqual(legacyStored);
    expect(bundleExportReplayV2Schema.parse(currentReplay)).toStrictEqual(currentReplay);
    expect(bundleExportReplayV1Schema.parse(legacyReplay)).toStrictEqual(legacyReplay);
    expect(bundleExportReplaySchema.parse(currentReplay)).toStrictEqual(currentReplay);
    expect(bundleExportReplaySchema.parse(legacyReplay)).toStrictEqual(legacyReplay);
    expect([
      legacyReplay.schemaVersion,
      legacyReplay.result.manifest.schemaVersion,
      legacyReplay.result.tool.capabilityProfile,
      legacyReplay.result.manifest.artifacts[0]!.tool.capabilityProfile
    ]).toStrictEqual([
      "evleda.bundle-export-replay.v1",
      "evleda.bundle-manifest.v2",
      "deterministic-zip-v2",
      "deterministic-zip-v2"
    ]);
    expect([
      currentReplay.schemaVersion,
      currentReplay.result.manifest.schemaVersion,
      currentReplay.result.tool.capabilityProfile,
      currentReplay.result.manifest.artifacts[0]!.tool.capabilityProfile
    ]).toStrictEqual([
      "evleda.bundle-export-replay.v2",
      "evleda.bundle-manifest.v3",
      "deterministic-zip-v3",
      "deterministic-zip-v3"
    ]);
    expect("liveRegenerationPolicy" in bundleExportReplaySchema.parse(legacyReplay).result).toBe(false);
    expect("liveRegenerationPolicyIdentity" in bundleExportReplaySchema.parse(legacyReplay).result).toBe(false);

    const currentWithZip2 = structuredClone(currentReplay) as Record<string, any>;
    currentWithZip2.result.tool.capabilityProfile = "deterministic-zip-v2";
    const currentWithArtifactZip2 = structuredClone(currentReplay) as Record<string, any>;
    currentWithArtifactZip2.result.manifest.artifacts[0].tool.capabilityProfile =
      "deterministic-zip-v2";
    const legacyWithZip3 = structuredClone(legacyReplay) as Record<string, any>;
    legacyWithZip3.result.tool.capabilityProfile = "deterministic-zip-v3";
    const legacyWithArtifactZip3 = structuredClone(legacyReplay) as Record<string, any>;
    legacyWithArtifactZip3.result.manifest.artifacts[0].tool.capabilityProfile =
      "deterministic-zip-v3";
    const currentManifestRelabeledV2 = structuredClone(currentReplay) as Record<string, any>;
    currentManifestRelabeledV2.result.manifest.schemaVersion = "evleda.bundle-manifest.v2";
    const legacyManifestRelabeledV3 = structuredClone(legacyReplay) as Record<string, any>;
    legacyManifestRelabeledV3.result.manifest.schemaVersion = "evleda.bundle-manifest.v3";
    const currentWithoutBundlerInToolchain = structuredClone(currentReplay) as Record<string, any>;
    currentWithoutBundlerInToolchain.result.manifest.toolchain = [];
    const currentWithDuplicateBundlerInToolchain = structuredClone(currentReplay) as Record<string, any>;
    currentWithDuplicateBundlerInToolchain.result.manifest.toolchain.push(bundler());
    const currentWithCrossedBundlerInToolchain = structuredClone(currentReplay) as Record<string, any>;
    currentWithCrossedBundlerInToolchain.result.manifest.toolchain = [bundler(false)];
    const currentWithUnreferencedToolInToolchain = structuredClone(currentReplay) as Record<string, any>;
    currentWithUnreferencedToolInToolchain.result.manifest.toolchain.push({
      name: "unreferenced-tool",
      version: "1",
      adapter: "external"
    });
    const legacyWithoutBundlerInToolchain = structuredClone(legacyReplay) as Record<string, any>;
    legacyWithoutBundlerInToolchain.result.manifest.toolchain = [];
    const legacyWithDuplicateBundlerInToolchain = structuredClone(legacyReplay) as Record<string, any>;
    legacyWithDuplicateBundlerInToolchain.result.manifest.toolchain.push(bundler(false));
    const legacyWithCrossedBundlerInToolchain = structuredClone(legacyReplay) as Record<string, any>;
    legacyWithCrossedBundlerInToolchain.result.manifest.toolchain = [bundler()];

    for (const invalid of [
      { ...currentReplay, schemaVersion: "evleda.bundle-export-replay.v1" },
      { ...legacyReplay, schemaVersion: "evleda.bundle-export-replay.v2" },
      currentWithZip2,
      currentWithArtifactZip2,
      legacyWithZip3,
      legacyWithArtifactZip3,
      currentManifestRelabeledV2,
      legacyManifestRelabeledV3,
      currentWithoutBundlerInToolchain,
      currentWithDuplicateBundlerInToolchain,
      currentWithCrossedBundlerInToolchain,
      currentWithUnreferencedToolInToolchain,
      legacyWithoutBundlerInToolchain,
      legacyWithDuplicateBundlerInToolchain,
      legacyWithCrossedBundlerInToolchain
    ]) {
      expect(bundleExportReplaySchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      bundleExportReplaySchema.safeParse({ ...currentReplay, schemaVersion: "evleda.bundle-export-replay.v3" })
        .success
    ).toBe(false);
  });

  it("rejects policy-identity tampering inside a current durable replay", () => {
    const currentReplay = {
      schemaVersion: "evleda.bundle-export-replay.v2" as const,
      result: withoutBytes(currentResultFixture())
    };
    const tampered = structuredClone(currentReplay) as Record<string, any>;
    tampered.result.manifest.liveRegenerationPolicyIdentity.digest = "f".repeat(64);

    expect(bundleExportReplayV2Schema.safeParse(tampered).success).toBe(false);
    expect(bundleExportReplaySchema.safeParse(tampered).success).toBe(false);
  });
});

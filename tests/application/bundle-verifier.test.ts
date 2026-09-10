import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { deterministicId } from "../../src/core/ids.js";
import { localHumanContext } from "../../src/contracts/capabilities.js";
import {
  canonicalJsonV1 as verifierCanonicalJson,
  deterministicIdV1 as verifierDeterministicId
} from "../../scripts/verify-bundle.mjs";
import {
  createCompletedRun,
  disposeApplicationRoots,
  makeApplication,
  physicalEvidenceInput,
  qualifier
} from "./helpers.js";

const execFileAsync = promisify(execFile);
const extractionRoots: string[] = [];

afterEach(async () => {
  await disposeApplicationRoots();
  await Promise.all(
    extractionRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const extractBundle = async (bytes: Uint8Array): Promise<string> => {
  const extractionRoot = await mkdtemp(path.join(tmpdir(), "evleda-bundle-verify-"));
  extractionRoots.push(extractionRoot);
  const files = unzipSync(bytes);
  const names = Object.keys(files).filter((name) => !name.endsWith("/"));
  const rootName = names[0]?.split("/")[0];
  if (rootName === undefined || rootName.length === 0) throw new Error("ZIP has no root directory");
  for (const name of names) {
    const segments = name.split("/");
    if (segments[0] !== rootName || segments.some((segment) => segment === ".." || segment === "")) {
      throw new Error(`Unsafe ZIP fixture path: ${name}`);
    }
    const target = path.join(extractionRoot, ...segments);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, files[name]!);
  }
  return path.join(extractionRoot, rootName);
};

const verify = async (root: string, options: readonly string[] = []) =>
  execFileAsync(
    process.execPath,
    [path.resolve(process.cwd(), "scripts", "verify-bundle.mjs"), ...options, root],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );

describe("independent bundle verification", () => {
  it("matches frozen canonicalization and deterministic-ID vectors independently", () => {
    const vector = {
      z: -0,
      nested: { beta: true, alpha: [3, 2, 1] },
      text: "EvlEDA"
    };
    expect(verifierCanonicalJson(vector)).toBe(canonicalJson(vector));
    expect(verifierDeterministicId("revision", vector)).toBe(
      deterministicId("revision", vector)
    );
  });

  it("accepts the complete producer inventory and rejects extras or tampering", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const bundle = await service.exportCandidateBundle({
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "independent-verify-1"
    });
    const root = await extractBundle(Buffer.from(bundle.bytesBase64, "base64"));

    const verified = await verify(root);
    expect(verified.stdout).toContain("Bundle provenance verified");
    expect(verified.stdout).toContain(bundle.manifest.revisionManifest.digest);
    expect(verified.stdout).toContain(bundle.manifest.evidenceRoot.digest);
    expect(bundle.manifest.schemaVersion).toBe("evleda.bundle-manifest.v3");
    expect(bundle.manifest.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        "COVER.svg",
        "README.md",
        "WARNING.txt",
        "evidence/evidence.json",
        "provenance/revision.json"
      ])
    );
    const coverText = await readFile(path.join(root, "COVER.svg"), "utf8");
    expect(coverText).toMatch(
      /<text[^>]*>CANDIDATE — NOT FOR MANUFACTURING<\/text>/u
    );
    expect(coverText).toMatch(/<text[^>]*>Lifecycle: candidate<\/text>/u);
    expect(
      bundle.manifest.artifacts
        .filter((artifact) => artifact.sourceKind === "bundle_generated")
        .every(
          (artifact) =>
            artifact.sourceArtifactId.startsWith("bundle_artifact_") &&
            artifact.stage === "manufacturing_package" &&
            artifact.validationStatus === "pass" &&
            artifact.sourceDesignRevisionId === bundle.designRevisionId &&
            artifact.createdAt === null &&
            artifact.staleAt === null &&
            artifact.generationRole !== undefined
        )
    ).toBe(true);
    expect(
      bundle.manifest.artifacts.some(
        (artifact) =>
          artifact.sourceKind === "stored_artifact" &&
          artifact.sourceDesignRevisionId !== bundle.designRevisionId
      )
    ).toBe(true);
    await expect(
      verify(root, [
        "--expected-revision-manifest",
        bundle.manifest.revisionManifest.digest,
        "--expected-evidence-root",
        bundle.manifest.evidenceRoot.digest
      ])
    ).resolves.toMatchObject({ stdout: expect.stringContaining("Bundle provenance verified") });
    await expect(
      verify(root, ["--expected-revision-manifest", "0".repeat(64)])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Trusted expected revision manifest")
    });

    const extra = path.join(root, "unlisted.txt");
    await writeFile(extra, "not in the manifest", "utf8");
    await expect(verify(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("unlisted extra file")
    });
    await rm(extra);

    await writeFile(path.join(root, "WARNING.txt"), "tampered warning\n", "utf8");
    await expect(verify(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("Artifact identity mismatch")
    });
  }, 60_000);

  it("rejects semantic root tampering even after the attacker updates file hashes", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const bundle = await service.exportCandidateBundle({
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "independent-verify-semantic-tamper"
    });

    const evidenceRoot = await extractBundle(Buffer.from(bundle.bytesBase64, "base64"));
    const evidencePath = path.join(evidenceRoot, "evidence", "evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      evidence: { claim: string }[];
    };
    evidence.evidence[0]!.claim += " tampered";
    const evidenceBytes = Buffer.from(`${canonicalJson(evidence)}\n`, "utf8");
    await writeFile(evidencePath, evidenceBytes);
    const evidenceManifestPath = path.join(evidenceRoot, "bundle-manifest.json");
    const evidenceManifest = JSON.parse(await readFile(evidenceManifestPath, "utf8")) as typeof bundle.manifest;
    const evidenceEntry = evidenceManifest.artifacts.find(
      (artifact) => artifact.path === "evidence/evidence.json"
    )!;
    (evidenceEntry as { identity: ReturnType<typeof contentIdentity> }).identity =
      contentIdentity(evidenceBytes);
    await writeFile(evidenceManifestPath, `${canonicalJson(evidenceManifest)}\n`, "utf8");
    await expect(verify(evidenceRoot)).rejects.toMatchObject({
      stderr: expect.stringContaining("Evidence root mismatch")
    });

    const revisionRoot = await extractBundle(Buffer.from(bundle.bytesBase64, "base64"));
    const revisionPath = path.join(revisionRoot, "provenance", "revision.json");
    const revision = JSON.parse(await readFile(revisionPath, "utf8")) as {
      record: { stage: string };
    };
    revision.record.stage = "schematic";
    const revisionBytes = Buffer.from(`${canonicalJson(revision)}\n`, "utf8");
    await writeFile(revisionPath, revisionBytes);
    const revisionManifestPath = path.join(revisionRoot, "bundle-manifest.json");
    const revisionManifest = JSON.parse(await readFile(revisionManifestPath, "utf8")) as typeof bundle.manifest;
    const revisionEntry = revisionManifest.artifacts.find(
      (artifact) => artifact.path === "provenance/revision.json"
    )!;
    (revisionEntry as { identity: ReturnType<typeof contentIdentity> }).identity =
      contentIdentity(revisionBytes);
    await writeFile(revisionManifestPath, `${canonicalJson(revisionManifest)}\n`, "utf8");
    await expect(verify(revisionRoot)).rejects.toMatchObject({
      stderr: expect.stringContaining("Revision root mismatch")
    });

    const originRoot = await extractBundle(Buffer.from(bundle.bytesBase64, "base64"));
    const originManifestPath = path.join(originRoot, "bundle-manifest.json");
    const originManifest = JSON.parse(await readFile(originManifestPath, "utf8")) as typeof bundle.manifest;
    const inherited = originManifest.artifacts.find(
      (artifact) =>
        artifact.sourceKind === "stored_artifact" &&
        artifact.sourceDesignRevisionId !== bundle.designRevisionId
    )!;
    (inherited as { sourceDesignRevisionId: string }).sourceDesignRevisionId =
      bundle.designRevisionId;
    await writeFile(originManifestPath, `${canonicalJson(originManifest)}\n`, "utf8");
    await expect(verify(originRoot)).rejects.toMatchObject({
      stderr: expect.stringContaining("provenance does not match revision record")
    });

    const generatedRoot = await extractBundle(Buffer.from(bundle.bytesBase64, "base64"));
    const generatedManifestPath = path.join(generatedRoot, "bundle-manifest.json");
    const generatedManifest = JSON.parse(
      await readFile(generatedManifestPath, "utf8")
    ) as typeof bundle.manifest;
    const generated = generatedManifest.artifacts.find(
      (artifact) => artifact.generationRole === "warning"
    )!;
    (generated as { sourceArtifactId: string }).sourceArtifactId =
      `bundle_artifact_${"0".repeat(24)}`;
    await writeFile(generatedManifestPath, `${canonicalJson(generatedManifest)}\n`, "utf8");
    await expect(verify(generatedRoot)).rejects.toMatchObject({
      stderr: expect.stringContaining("Generated artifact ID")
    });

    const coverRoot = await extractBundle(Buffer.from(bundle.bytesBase64, "base64"));
    const coverPath = path.join(coverRoot, "COVER.svg");
    const coverBytes = Buffer.from(
      (await readFile(coverPath, "utf8")).replaceAll(
        "CANDIDATE — NOT FOR MANUFACTURING",
        "CANDIDATE REVIEW PACKAGE"
      ),
      "utf8"
    );
    await writeFile(coverPath, coverBytes);
    const coverManifestPath = path.join(coverRoot, "bundle-manifest.json");
    const coverManifest = JSON.parse(
      await readFile(coverManifestPath, "utf8")
    ) as typeof bundle.manifest;
    const cover = coverManifest.artifacts.find(
      (artifact) => artifact.generationRole === "cover"
    )!;
    const coverIdentity = contentIdentity(coverBytes);
    (cover as { identity: ReturnType<typeof contentIdentity> }).identity = coverIdentity;
    (cover as { sourceArtifactId: string }).sourceArtifactId = deterministicId(
      "bundle_artifact",
      {
        source: "evleda_bundle_generator",
        bundleKind: coverManifest.bundleKind,
        role: "cover",
        projectId: coverManifest.projectId,
        runId: coverManifest.runId,
        designRevisionId: coverManifest.designRevisionId,
        revisionManifest: coverManifest.revisionManifest,
        evidenceRoot: coverManifest.evidenceRoot,
        liveRegenerationPolicyIdentity: coverManifest.liveRegenerationPolicyIdentity,
        identity: coverIdentity
      }
    );
    await writeFile(coverManifestPath, `${canonicalJson(coverManifest)}\n`, "utf8");
    await expect(verify(coverRoot)).rejects.toMatchObject({
      stderr: expect.stringContaining("Lifecycle cover does not visibly render")
    });

    const aggregateRoot = await extractBundle(Buffer.from(bundle.bytesBase64, "base64"));
    const aggregateManifestPath = path.join(aggregateRoot, "bundle-manifest.json");
    const aggregateManifest = JSON.parse(
      await readFile(aggregateManifestPath, "utf8")
    ) as typeof bundle.manifest;
    (aggregateManifest.toolchain as unknown as { name: string }[]).pop();
    await writeFile(aggregateManifestPath, `${canonicalJson(aggregateManifest)}\n`, "utf8");
    await expect(verify(aggregateRoot)).rejects.toMatchObject({
      stderr: expect.stringContaining("exact provenance tool union")
    });
  }, 60_000);

  it("verifies a qualified prototype with post-revision physical evidence provenance", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const input = await physicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "independent-prototype-physical",
      "PROTOTYPE-VERIFY-001"
    );
    const physical = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    await service.qualifyRevision(
      {
        revisionId: revision.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Verify complete post-revision provenance in one controlled prototype bundle.",
        scope: "one controlled prototype verifier fixture",
        expectedRevision: afterPhysical.run.revision,
        idempotencyKey: "independent-prototype-qualification"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const beforeExport = await service.getRunStatus({ runId: completed.run.id });
    const bundle = await service.exportPrototypeBundle({
      revisionId: revision.id,
      expectedRevision: beforeExport.run.revision,
      idempotencyKey: "independent-prototype-export"
    });
    const root = await extractBundle(Buffer.from(bundle.bytesBase64, "base64"));
    const verified = await verify(root);

    expect(verified.stdout).toContain("prototype/qualified");
    const coverText = await readFile(path.join(root, "COVER.svg"), "utf8");
    expect(coverText).toMatch(
      /<text[^>]*>PROTOTYPE — NOT PRODUCTION RELEASED<\/text>/u
    );
    expect(coverText).toMatch(/<text[^>]*>Lifecycle: qualified<\/text>/u);
    expect(coverText).toMatch(/<text[^>]*>CONTROLLED PROTOTYPE ONLY<\/text>/u);
    expect(bundle.manifest.artifacts.some(
      (artifact) => artifact.sourceArtifactId === physical.rawArtifact.id
    )).toBe(true);
    const parsedPhysical = bundle.manifest.artifacts.find(
      (artifact) => artifact.sourceArtifactId === physical.parsedArtifact.id
    );
    expect(parsedPhysical).toBeDefined();
    const physicalRecord = JSON.parse(
      await readFile(path.join(root, parsedPhysical!.path), "utf8")
    );
    expect(physicalRecord).toMatchObject({
      schemaVersion: "evleda.human-physical-evidence.v3",
      bringupPlan: { schemaVersion: "evleda.bringup-plan.v2" },
      acceptanceContract: { schemaVersion: "evleda.physical-acceptance.v2" },
      measurementRecord: { schemaVersion: "evleda.physical-measurements.v2" },
      results: { overallVerdict: "pass" }
    });
  }, 60_000);
});

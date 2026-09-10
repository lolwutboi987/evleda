#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonV1, verifyBundle } from "./verify-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyV3FixtureRoot = path.join(
  root,
  "scripts",
  "fixtures",
  "valid-legacy-v3-candidate-bundle"
);
const legacyV2FixtureRoot = path.join(
  root,
  "scripts",
  "fixtures",
  "valid-legacy-v2-candidate-bundle"
);
const legacyV3Manifest = JSON.parse(
  await readFile(path.join(legacyV3FixtureRoot, "bundle-manifest.json"), "utf8")
);
const legacyV2Manifest = JSON.parse(
  await readFile(path.join(legacyV2FixtureRoot, "bundle-manifest.json"), "utf8")
);
const fixtureManifest = legacyV3Manifest;
const fixtureRoot = legacyV3FixtureRoot;
const legacyManifest = {
  schemaVersion: "evleda.bundle-manifest.v1",
  canonicalizationVersion: legacyV2Manifest.canonicalizationVersion,
  bundleKind: legacyV2Manifest.bundleKind,
  lifecycle: legacyV2Manifest.lifecycle,
  projectId: legacyV2Manifest.projectId,
  runId: legacyV2Manifest.runId,
  designRevisionId: legacyV2Manifest.designRevisionId,
  revisionManifest: legacyV2Manifest.revisionManifest,
  evidenceRoot: legacyV2Manifest.evidenceRoot,
  warning: legacyV2Manifest.warning,
  artifacts: legacyV2Manifest.artifacts
    .filter((artifact) => artifact.generationRole !== "revision_record")
    .map((artifact) => ({
      path: artifact.path,
      logicalName: artifact.logicalName,
      mediaType: artifact.mediaType,
      identity: artifact.identity,
      stage: artifact.stage,
      validationStatus: artifact.validationStatus,
      sourceArtifactId: artifact.sourceArtifactId,
      projectId: artifact.projectId,
      runId: artifact.runId,
      designRevisionId: artifact.designRevisionId
    })),
  toolchain: legacyV2Manifest.toolchain,
  unresolvedAssumptions: legacyV2Manifest.unresolvedAssumptions
};
const fixtureArtifact = path.join(legacyV3FixtureRoot, "artifacts", "metadata.json");
const temporaryBase = path.resolve(os.tmpdir());
const temporaryRoot = await mkdtemp(path.join(temporaryBase, "evleda-bundle-verifier-"));

const frozenFixtureInventories = Object.freeze({
  "valid-legacy-v2-candidate-bundle": Object.freeze({
    "COVER.svg": Object.freeze({ size: 1159, sha256: "09346b5a1559076ce4d75a6b2485336f39be98cfee55048f09ca6851c49f4e76" }),
    "README.md": Object.freeze({ size: 38, sha256: "735d67a35ba31b294db8ba8a8e838ed1d9c406ed6bfac9a4b9c139c29f0e2962" }),
    "WARNING.txt": Object.freeze({ size: 36, sha256: "010e4c84ca9b6017374a59e7c66e131f53484ac909206e4459193c809182fdd1" }),
    "artifacts/metadata.json": Object.freeze({ size: 17, sha256: "218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9" }),
    "bundle-manifest.json": Object.freeze({ size: 8085, sha256: "c2c7c2bd001d6bcb3d6278288caf18cfb7e1145749412805b888dcb4ff215ad7" }),
    "evidence/evidence.json": Object.freeze({ size: 312, sha256: "e3b6879db89c43c982b5ad81dd1848290c262129e4b74ab5359e894b1d2c4003" }),
    "provenance/revision.json": Object.freeze({ size: 1769, sha256: "7a84721a593b787d54a8659621964fee4062c5a2fdf859c999304e3f2e5e17ca" })
  }),
  "valid-legacy-v3-candidate-bundle": Object.freeze({
    "COVER.svg": Object.freeze({ size: 1159, sha256: "09346b5a1559076ce4d75a6b2485336f39be98cfee55048f09ca6851c49f4e76" }),
    "README.md": Object.freeze({ size: 38, sha256: "735d67a35ba31b294db8ba8a8e838ed1d9c406ed6bfac9a4b9c139c29f0e2962" }),
    "WARNING.txt": Object.freeze({ size: 36, sha256: "010e4c84ca9b6017374a59e7c66e131f53484ac909206e4459193c809182fdd1" }),
    "artifacts/metadata.json": Object.freeze({ size: 17, sha256: "218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9" }),
    "bundle-manifest.json": Object.freeze({ size: 10015, sha256: "9eca214242c65b201dead90b7f91d8edadf35a85a7542c6cdd1241a626e8adf6" }),
    "evidence/evidence.json": Object.freeze({ size: 312, sha256: "e3b6879db89c43c982b5ad81dd1848290c262129e4b74ab5359e894b1d2c4003" }),
    "provenance/revision.json": Object.freeze({ size: 1769, sha256: "7a84721a593b787d54a8659621964fee4062c5a2fdf859c999304e3f2e5e17ca" })
  })
});

const clone = (value) => structuredClone(value);
let assertions = 0;

const listFixtureFiles = async (directory, prefix = "") => {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listFixtureFiles(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Frozen fixture contains a non-ordinary entry: ${relative}`);
    }
  }
  return files;
};

const assertFrozenFixture = async (fixtureName, directory) => {
  const expected = frozenFixtureInventories[fixtureName];
  const actualPaths = await listFixtureFiles(directory);
  const expectedPaths = Object.keys(expected).sort((left, right) => left.localeCompare(right, "en"));
  if (canonicalJsonV1(actualPaths) !== canonicalJsonV1(expectedPaths)) {
    throw new Error(`${fixtureName} inventory drifted`);
  }
  for (const relative of expectedPaths) {
    const bytes = await readFile(path.join(directory, ...relative.split("/")));
    const actual = {
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
    if (canonicalJsonV1(actual) !== canonicalJsonV1(expected[relative])) {
      throw new Error(`${fixtureName}/${relative} drifted`);
    }
  }
  assertions += 1;
  console.log(`ok - frozen ${fixtureName} exact inventory and hashes`);
};

const makeCase = async (name, manifest = clone(fixtureManifest), includeArtifact = true) => {
  const directory = path.join(temporaryRoot, name);
  const sourceInventory = manifest.schemaVersion === "evleda.bundle-manifest.v1"
    ? legacyManifest.artifacts
    : manifest.schemaVersion === "evleda.bundle-manifest.v2"
      ? legacyV2Manifest.artifacts
      : fixtureManifest.artifacts;
  const sourceRoot = new Set([
    "evleda.bundle-manifest.v1",
    "evleda.bundle-manifest.v2"
  ]).has(manifest.schemaVersion)
    ? legacyV2FixtureRoot
    : fixtureRoot;
  await Promise.all(
    sourceInventory.map(async (artifact, index) => {
      if (!includeArtifact && index === 0) return;
      const target = path.join(directory, ...artifact.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(sourceRoot, ...artifact.path.split("/")), target);
    })
  );
  await writeFile(path.join(directory, "bundle-manifest.json"), `${canonicalJsonV1(manifest)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  return directory;
};

const expectPass = async (name, prepare, options = {}) => {
  const directory = await prepare();
  const result = await verifyBundle(directory, options);
  assertions += 1;
  console.log(`ok - ${name}`);
  return result;
};

const expectFailure = async (
  name,
  expectedPattern,
  prepare,
  options = {}
) => {
  const directory = await prepare();
  try {
    await verifyBundle(directory, options);
    throw new Error(`Verifier unexpectedly accepted case: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === `Verifier unexpectedly accepted case: ${name}`) throw error;
    if (!expectedPattern.test(message)) {
      throw new Error(`${name} failed for the wrong reason: ${message}`);
    }
  }
  assertions += 1;
  console.log(`ok - rejects ${name}`);
};

try {
  await assertFrozenFixture("valid-legacy-v2-candidate-bundle", legacyV2FixtureRoot);
  await assertFrozenFixture("valid-legacy-v3-candidate-bundle", legacyV3FixtureRoot);

  await expectFailure(
    "legacy v1 without explicit downgrade",
    /Legacy.*byte inventory/iu,
    () => makeCase("legacy-default-denied", clone(legacyManifest)),
    {}
  );

  await expectPass(
    "explicit legacy candidate byte-integrity fixture",
    () => makeCase("legacy-valid", clone(legacyManifest)),
    { allowLegacyV1: true }
  );

  await expectFailure(
    "legacy v2 without explicit downgrade",
    /Legacy.*v2.*allow-legacy-v2/iu,
    () => makeCase("legacy-v2-default-denied", clone(legacyV2Manifest))
  );

  const legacyV2Result = await expectPass(
    "explicit unlabeled legacy v2 provenance fixture",
    () => makeCase("legacy-v2-valid", clone(legacyV2Manifest)),
    {
      allowLegacyV2: true,
      expectedRevisionManifest: legacyV2Manifest.revisionManifest.digest,
      expectedEvidenceRoot: legacyV2Manifest.evidenceRoot.digest
    }
  );
  if (
    legacyV2Result.assurance !== "provenance_roots_without_live_policy" ||
    legacyV2Result.revisionManifestDigest !== legacyV2Manifest.revisionManifest.digest ||
    legacyV2Result.evidenceRootDigest !== legacyV2Manifest.evidenceRoot.digest
  ) {
    throw new Error("Legacy v2 verification did not preserve its explicit downgraded assurance");
  }

  await expectFailure(
    "legacy v2 trusted revision-root mismatch",
    /Trusted expected revision manifest/u,
    () => makeCase("legacy-v2-root-mismatch", clone(legacyV2Manifest)),
    { allowLegacyV2: true, expectedRevisionManifest: "0".repeat(64) }
  );

  await expectFailure(
    "labeled legacy v2 even with explicit downgrade",
    /liveRegenerationPolicy.*not permitted/u,
    async () => {
      const manifest = clone(legacyV2Manifest);
      manifest.liveRegenerationPolicy = clone(fixtureManifest.liveRegenerationPolicy);
      manifest.liveRegenerationPolicyIdentity = clone(
        fixtureManifest.liveRegenerationPolicyIdentity
      );
      return makeCase("legacy-v2-labeled", manifest);
    },
    { allowLegacyV2: true }
  );

  const currentResult = await expectPass(
    "frozen policy-bound legacy v3 provenance-root candidate fixture",
    () => makeCase("valid")
  );
  if (currentResult.assurance !== "provenance_roots") {
    throw new Error("Current v3 verification returned downgraded assurance");
  }

  await expectFailure(
    "unknown future manifest version",
    /schemaVersion must be.*v3/u,
    async () => {
      const manifest = clone(fixtureManifest);
      manifest.schemaVersion = "evleda.bundle-manifest.v4";
      return makeCase("unknown-v4", manifest);
    }
  );

  await expectFailure(
    "missing live-regeneration policy",
    /liveRegenerationPolicy|missing required key/u,
    async () => {
      const manifest = clone(fixtureManifest);
      delete manifest.liveRegenerationPolicy;
      return makeCase("missing-live-regeneration-policy", manifest);
    }
  );

  await expectFailure(
    "live regeneration relabeled reproducible",
    /claim must be traceable|reproducible must be false/u,
    async () => {
      const manifest = clone(fixtureManifest);
      manifest.liveRegenerationPolicy.claim = "reproducible";
      manifest.liveRegenerationPolicy.reproducible = true;
      return makeCase("reproducible-live-regeneration", manifest);
    }
  );

  await expectFailure(
    "missing live-regeneration policy identity",
    /liveRegenerationPolicyIdentity.*required/u,
    async () => {
      const manifest = clone(fixtureManifest);
      delete manifest.liveRegenerationPolicyIdentity;
      return makeCase("missing-live-regeneration-policy-identity", manifest);
    }
  );

  await expectFailure(
    "mismatched live-regeneration policy identity",
    /policy identity does not match/u,
    async () => {
      const manifest = clone(fixtureManifest);
      manifest.liveRegenerationPolicyIdentity.digest = "0".repeat(64);
      return makeCase("mismatched-live-regeneration-policy-identity", manifest);
    }
  );

  await expectFailure(
    "incomplete top-level v3 exact inputs",
    /exactInputs.*(?:exactly equal|incomplete)/u,
    async () => {
      const manifest = clone(fixtureManifest);
      manifest.exactInputs = manifest.exactInputs.slice(0, 2);
      return makeCase("incomplete-v3-manifest-inputs", manifest);
    }
  );

  for (const role of ["cover", "evidence_inventory", "revision_record", "readme", "warning"]) {
    await expectFailure(
      `${role} missing policy identity input`,
      new RegExp(`exactInputs.*${role}`, "u"),
      async () => {
        const manifest = clone(fixtureManifest);
        const artifact = manifest.artifacts.find((entry) => entry.generationRole === role);
        artifact.exactInputs = artifact.exactInputs.slice(0, 2);
        return makeCase(`missing-policy-input-${role}`, manifest);
      }
    );
  }

  await expectFailure(
    "v3 generated artifact reuses legacy v2 source ID",
    /Generated artifact ID/u,
    async () => {
      const manifest = clone(fixtureManifest);
      const current = manifest.artifacts.find((entry) => entry.generationRole === "cover");
      const legacy = legacyV2Manifest.artifacts.find(
        (entry) => entry.generationRole === "cover"
      );
      current.sourceArtifactId = legacy.sourceArtifactId;
      return makeCase("legacy-v2-generated-id-in-v3", manifest);
    }
  );

  await expectFailure(
    "v3 generated artifact uses legacy v2 bundler profile",
    /invalid generated-artifact provenance/u,
    async () => {
      const manifest = clone(fixtureManifest);
      const artifact = manifest.artifacts.find((entry) => entry.generationRole === "cover");
      artifact.tool.capabilityProfile = "deterministic-zip-v2";
      return makeCase("legacy-v2-bundler-in-v3", manifest);
    }
  );

  await expectFailure(
    "v2 manifest relabeled v3 without v3 policy bindings",
    /liveRegenerationPolicy|exactInputs|missing required key/u,
    async () => {
      const manifest = clone(legacyV2Manifest);
      manifest.schemaVersion = "evleda.bundle-manifest.v3";
      return makeCase("v2-relabeled-v3", manifest);
    }
  );

  await expectFailure(
    "v2 manifest crossed with deterministic-zip-v3",
    /deterministic-zip-v2|invalid generated-artifact provenance/u,
    async () => {
      const manifest = clone(legacyV2Manifest);
      const artifact = manifest.artifacts.find((entry) => entry.generationRole === "cover");
      artifact.tool.capabilityProfile = "deterministic-zip-v3";
      return makeCase("v2-crossed-zip-v3", manifest);
    },
    { allowLegacyV2: true }
  );

  await expectFailure("parent traversal", /traversal|relative/u, async () => {
    const manifest = clone(fixtureManifest);
    manifest.artifacts[0].path = "../escape.json";
    return makeCase("traversal", manifest);
  });

  await expectFailure("duplicate paths", /strictly sorted|collides/u, async () => {
    const manifest = clone(fixtureManifest);
    manifest.artifacts.push(clone(manifest.artifacts[0]));
    return makeCase("duplicate", manifest);
  });

  await expectFailure("case-colliding paths", /collides/u, async () => {
    const manifest = clone(fixtureManifest);
    const second = clone(manifest.artifacts[0]);
    second.path = "artifacts/Metadata.json";
    manifest.artifacts = [second, manifest.artifacts[0]].sort((left, right) =>
      left.path.localeCompare(right.path, "en")
    );
    return makeCase("case-collision", manifest);
  });

  await expectFailure("missing artifact", /missing/u, () => makeCase("missing", clone(fixtureManifest), false));

  await expectFailure("unlisted extra file", /extra file/u, async () => {
    const directory = await makeCase("extra");
    await writeFile(path.join(directory, "extra.txt"), "unlisted\n", { encoding: "utf8", flag: "wx" });
    return directory;
  });

  await expectFailure("digest mismatch", /identity mismatch/u, async () => {
    const manifest = clone(fixtureManifest);
    manifest.artifacts[0].identity.digest = "f".repeat(64);
    return makeCase("digest", manifest);
  });

  await expectFailure("size mismatch", /identity mismatch/u, async () => {
    const manifest = clone(fixtureManifest);
    manifest.artifacts[0].identity.size += 1;
    return makeCase("size", manifest);
  });

  await expectFailure("candidate with qualified lifecycle", /policy mismatch/iu, async () => {
    const manifest = clone(fixtureManifest);
    manifest.lifecycle = "qualified";
    return makeCase("lifecycle", manifest);
  });

  await expectFailure("wrong candidate warning", /policy mismatch/iu, async () => {
    const manifest = clone(fixtureManifest);
    manifest.warning = "candidate";
    return makeCase("warning", manifest);
  });

  await expectFailure("mixed design revision", /does not match/iu, async () => {
    const manifest = clone(fixtureManifest);
    manifest.artifacts[0].designRevisionId = "revision_other";
    return makeCase("mixed-revision", manifest);
  });

  await expectFailure("symlink or junction", /symbolic link|junction|outside/iu, async () => {
    const manifest = clone(fixtureManifest);
    manifest.artifacts[0].path = "artifacts/linked/metadata.json";
    const directory = await makeCase("link", manifest, false);
    const outside = path.join(temporaryRoot, "link-target");
    await mkdir(outside, { recursive: true });
    await copyFile(fixtureArtifact, path.join(outside, "metadata.json"));
    const link = path.join(directory, "artifacts", "linked");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    return directory;
  });

  console.log(`Bundle verifier adversarial checks passed: ${assertions} cases.`);
} finally {
  const resolved = path.resolve(temporaryRoot);
  const relative = path.relative(temporaryBase, resolved);
  if (
    relative.startsWith(`evleda-bundle-verifier-${path.sep}`) ||
    (/^evleda-bundle-verifier-[^/\\]+$/u.test(relative) && !path.isAbsolute(relative))
  ) {
    await rm(resolved, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to remove unexpected temporary path: ${resolved}`);
  }
}

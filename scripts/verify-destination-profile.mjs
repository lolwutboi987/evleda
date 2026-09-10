import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot, sha256 } from "./verify-kicad-inspection-runtime.mjs";

const [profilePath, digest, sizeText] = process.argv.slice(2);
if (process.argv.length !== 5 || !profilePath || !/^[0-9a-f]{64}$/u.test(digest ?? "") || !/^[1-9][0-9]*$/u.test(sizeText ?? "")) {
  throw new Error("Usage: node scripts/verify-destination-profile.mjs <profile> <sha256> <bytes> (run pnpm build first)");
}
const bytes = await readFile(profilePath);
assert.equal(sha256(bytes), digest, "Profile pin differs");
assert.equal(bytes.length, Number(sizeText), "Profile byte count differs");
const pinned = { path: path.resolve(profilePath), contentIdentity: { algorithm: "sha256", digest, size: bytes.length } };
const working = path.resolve(repositoryRoot, "..", "working-runtime");
const evidence = await mkdtemp(path.join(working, "load-check-"));
const sourceRoot = path.join(evidence, "source");
const outputRoot = path.join(evidence, "output");
await mkdir(sourceRoot); await mkdir(outputRoot);
const { loadKicadToolboxFreshProfile } = await import("../dist/src/mcp/toolbox-fresh-profile.js");
const { loadKicadToolboxNativeProfile } = await import("../dist/src/mcp/toolbox-native-profile.js");
const startedAt = new Date().toISOString();
const startedMs = Date.now();
let stage = "fresh-profile";
let report;
let failure;
try {
  const fresh = await loadKicadToolboxFreshProfile(pinned);
  stage = "native-profile";
  const native = await loadKicadToolboxNativeProfile({ profile: pinned, sourceRoot, outputRoot, additionalProtectedRoots: fresh.protectedRoots });
  assert.equal(sha256(await readFile(profilePath)), digest, "Profile changed during verification");
  report = {
  schemaVersion: "evleda.destination-profile-load-verification.v1", status: "passed", startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - startedMs, nodeVersion: process.version,
  profile: { path: pinned.path, sha256: digest, sizeBytes: bytes.length }, sourceRoot, outputRoot,
  profileIdentity: native.profileIdentity, freshProfileIdentity: fresh.profileIdentity,
  runtimeBridgeIdentity: native.bridge.identity,
  deepRulesResourceRoot: fresh.protectedRoots[2], approvedLibrariesVerified: fresh.searchLibrary === undefined, deepRulesVerified: true,
  libraryVerificationScope: fresh.searchLibrary === undefined ? "all-profile-exact-ids-inspected" : "catalog-policy-and-roots-only",
  ...(fresh.searchLibrary === undefined ? {} : { catalogPolicyVerified: true, allCatalogSourcesInspected: false }),
  editorLauncherBound: typeof native.editorLauncher === "function", transmissionLineBound: native.transmissionLine !== undefined, referenceCoverageBound: native.referenceCoverage !== undefined,
  scope: { editorLaunched: false, sidecarLaunched: false, modelRequested: false, serverStarted: false, nativeBoardValidated: false },
  };
} catch (error) {
  failure = error;
  report = { schemaVersion: "evleda.destination-profile-load-verification.v1", status: "failed", startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - startedMs, nodeVersion: process.version,
    profile: { path: pinned.path, sha256: digest, sizeBytes: bytes.length }, sourceRoot, outputRoot, stage,
    error: { name: error.name, message: error.message, stack: error.stack, ...(error.reason === undefined ? {} : { reason: error.reason }) },
    scope: { editorLaunched: false, sidecarLaunched: false, modelRequested: false, serverStarted: false, nativeBoardValidated: false } };
}
await writeFile(path.join(evidence, "result.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ ...report, evidence: path.join(evidence, "result.json") }, null, 2));
if (failure) process.exitCode = 1;

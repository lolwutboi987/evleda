import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import {
  createCompletedRun,
  disposeApplicationRoots,
  makeApplication
} from "../tests/application/helpers.js";
import { verifyBundle } from "./verify-bundle.mjs";

const temporaryBase = path.resolve(os.tmpdir());
const temporaryRoot = await mkdtemp(path.join(temporaryBase, "evleda-export-verifier-"));

try {
  const service = await makeApplication();
  const completed = await createCompletedRun(service);
  if (completed.headRevision === undefined) throw new Error("Completed fixture has no head revision");
  const exported = await service.exportCandidateBundle({
    revisionId: completed.headRevision.id,
    expectedRevision: completed.run.revision,
    idempotencyKey: "script-export-verify-0001"
  });
  const entries = unzipSync(Buffer.from(exported.bytesBase64, "base64"));
  const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
  const rootName = names[0]?.split("/")[0];
  if (
    rootName === undefined ||
    !/^CANDIDATE-NOT-FOR-MANUFACTURING-[a-zA-Z0-9._-]+$/u.test(rootName)
  ) {
    throw new Error("Export has no valid candidate root directory");
  }

  for (const name of names) {
    if (name.includes("\\") || !name.startsWith(`${rootName}/`)) {
      throw new Error(`Export entry is outside the expected root: ${name}`);
    }
    const relative = name.slice(rootName.length + 1);
    const segments = relative.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`Export entry contains an unsafe segment: ${name}`);
    }
    const destination = path.join(temporaryRoot, rootName, ...segments);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entries[name]!, { flag: "wx" });
  }

  const verified = await verifyBundle(path.join(temporaryRoot, rootName));
  if (
    verified.assurance !== "provenance_roots" ||
    verified.projectId !== exported.projectId ||
    verified.runId !== exported.runId ||
    verified.designRevisionId !== exported.designRevisionId ||
    verified.artifactCount !== exported.manifest.artifacts.length ||
    verified.revisionManifestDigest !== exported.manifest.revisionManifest.digest ||
    verified.evidenceRootDigest !== exported.manifest.evidenceRoot.digest
  ) {
    throw new Error("Independent bundle verification returned different bound identities");
  }
  console.log(
    `Export/verifier integration passed: ${verified.artifactCount} manifest-bound files, ` +
      `${verified.artifactBytes} bytes.`
  );
  console.log("No physical, qualification, safety, or release result was asserted.");
} finally {
  await disposeApplicationRoots();
  const resolved = path.resolve(temporaryRoot);
  const relative = path.relative(temporaryBase, resolved);
  if (/^evleda-export-verifier-[^/\\]+$/u.test(relative) && !path.isAbsolute(relative)) {
    await rm(resolved, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to remove unexpected temporary path: ${resolved}`);
  }
}

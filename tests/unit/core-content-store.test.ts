import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { DomainError } from "../../src/domain/errors.js";
import { FileContentStore } from "../../src/persistence/content-store.js";

const temporaryRoots: string[] = [];

const makeStore = async (): Promise<FileContentStore> => {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-content-"));
  temporaryRoots.push(root);
  const store = new FileContentStore(root);
  await store.initialize();
  return store;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileContentStore", () => {
  it("deduplicates identical bytes by SHA-256 identity", async () => {
    const store = await makeStore();
    const first = await store.put("same bytes");
    const second = await store.put(Buffer.from("same bytes"));

    expect(second).toEqual(first);
    await expect(store.get(first)).resolves.toEqual(Buffer.from("same bytes"));
  });

  it("rejects a caller-supplied mismatched digest", async () => {
    const store = await makeStore();
    const wrong = contentIdentity("different bytes");

    await expect(store.put("actual bytes", wrong)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH"
    });
  });

  it("fails closed when stored bytes are changed", async () => {
    const store = await makeStore();
    const identity = await store.put("trusted bytes");
    const target = store.pathFor(identity);
    expect(await readFile(target, "utf8")).toBe("trusted bytes");

    await writeFile(target, "tampered");
    await expect(store.get(identity)).rejects.toBeInstanceOf(DomainError);
    await expect(store.get(identity)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
  });
});


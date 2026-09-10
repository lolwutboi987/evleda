import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ContentIdentity } from "../domain/types.js";
import { DomainError } from "../domain/errors.js";
import { canonicalJson, constantTimeDigestEqual, contentIdentity } from "../core/canonical.js";
import { resolveWithinRoot } from "../core/path-policy.js";

export class FileContentStore {
  readonly #blobRoot: string;
  readonly #stagingRoot: string;

  public constructor(public readonly root: string) {
    this.#blobRoot = resolveWithinRoot(root, "blobs/sha256");
    this.#stagingRoot = resolveWithinRoot(root, "staging");
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#blobRoot, { recursive: true }),
      mkdir(this.#stagingRoot, { recursive: true })
    ]);
  }

  public pathFor(identity: ContentIdentity): string {
    this.#validateIdentity(identity);
    return resolveWithinRoot(
      this.#blobRoot,
      path.join(identity.digest.slice(0, 2), identity.digest.slice(2))
    );
  }

  public async put(
    bytes: Uint8Array | string,
    expected?: ContentIdentity
  ): Promise<ContentIdentity> {
    await this.initialize();
    const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    const actual = contentIdentity(buffer);
    if (
      expected !== undefined &&
      (!constantTimeDigestEqual(actual.digest, expected.digest) || actual.size !== expected.size)
    ) {
      throw new DomainError("DIGEST_MISMATCH", "Provided bytes do not match expected identity", {
        expected,
        actual
      });
    }

    const target = this.pathFor(actual);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      const existingIdentity = contentIdentity(existing);
      if (
        existingIdentity.size !== actual.size ||
        !constantTimeDigestEqual(existingIdentity.digest, actual.digest)
      ) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Existing content-addressed object is corrupt",
          { expected: actual, actual: existingIdentity }
        );
      }
      return actual;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
    }

    const staging = resolveWithinRoot(this.#stagingRoot, `${randomUUID()}.tmp`);
    const handle = await open(staging, "wx");
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(staging, target);
    } catch (error) {
      try {
        const winner = await readFile(target);
        const winnerIdentity = contentIdentity(winner);
        if (
          winnerIdentity.size !== actual.size ||
          !constantTimeDigestEqual(winnerIdentity.digest, actual.digest)
        ) {
          throw new DomainError(
            "ARTIFACT_INTEGRITY_ERROR",
            "Concurrent content promotion produced a mismatched object",
            { expected: actual, actual: winnerIdentity }
          );
        }
      } finally {
        await rm(staging, { force: true });
      }
      if (error instanceof DomainError) {
        throw error;
      }
    }
    return actual;
  }

  public async putJson(value: unknown): Promise<ContentIdentity> {
    return this.put(`${canonicalJson(value)}\n`);
  }

  public async get(identity: ContentIdentity): Promise<Buffer> {
    this.#validateIdentity(identity);
    let bytes: Buffer;
    try {
      bytes = await readFile(this.pathFor(identity));
    } catch (error) {
      throw new DomainError("NOT_FOUND", "Content-addressed object is missing", {
        identity,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    const actual = contentIdentity(bytes);
    if (
      actual.size !== identity.size ||
      !constantTimeDigestEqual(actual.digest, identity.digest)
    ) {
      throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Stored object failed verification", {
        expected: identity,
        actual
      });
    }
    return bytes;
  }

  public async verify(identity: ContentIdentity): Promise<boolean> {
    await this.get(identity);
    return true;
  }

  #validateIdentity(identity: ContentIdentity): void {
    if (
      identity.algorithm !== "sha256" ||
      !/^[0-9a-f]{64}$/u.test(identity.digest) ||
      !Number.isSafeInteger(identity.size) ||
      identity.size < 0
    ) {
      throw new DomainError("INVALID_ARGUMENT", "Invalid content identity", { identity });
    }
  }
}


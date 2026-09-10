import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  replaceFileAtomically,
  syncContainingDirectory
} from "../../src/persistence/durability.js";

describe("syncContainingDirectory", () => {
  it("durably syncs a containing directory or returns only for an unsupported platform operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-directory-sync-"));
    const file = path.join(root, "durable.txt");
    try {
      await writeFile(file, "durable\n", "utf8");
      await expect(syncContainingDirectory(file)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries transient Windows replacement failures without deleting the prior durable file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-atomic-replace-"));
    const source = path.join(root, "state.next");
    const destination = path.join(root, "state.json");
    try {
      await writeFile(source, "new-state\n", "utf8");
      await writeFile(destination, "old-state\n", "utf8");
      let attempts = 0;

      await replaceFileAtomically(source, destination, "new-state\n", {
        maxRetries: 2,
        retryDelayMs: 0,
        renameFile: async (from, to) => {
          attempts += 1;
          if (attempts < 3) {
            expect(await readFile(destination, "utf8")).toBe("old-state\n");
            throw Object.assign(new Error("simulated Windows sharing violation"), { code: "EPERM" });
          }
          await rename(from, to);
        }
      });

      expect(attempts).toBe(3);
      expect(await readFile(destination, "utf8")).toBe("new-state\n");
      await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves both old and staged bytes intact when replacement retries are exhausted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-atomic-replace-failure-"));
    const source = path.join(root, "state.next");
    const destination = path.join(root, "state.json");
    try {
      await writeFile(source, "new-state\n", "utf8");
      await writeFile(destination, "old-state\n", "utf8");

      await expect(
        replaceFileAtomically(source, destination, "new-state\n", {
          maxRetries: 2,
          retryDelayMs: 0,
          renameFile: async () => {
            throw Object.assign(new Error("persistent sharing violation"), { code: "EPERM" });
          }
        })
      ).rejects.toMatchObject({ code: "EPERM" });

      expect(await readFile(destination, "utf8")).toBe("old-state\n");
      expect(await readFile(source, "utf8")).toBe("new-state\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a lost replacement acknowledgment from the committed destination bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-atomic-replace-ack-"));
    const source = path.join(root, "state.next");
    const destination = path.join(root, "state.json");
    try {
      await writeFile(source, "new-state\n", "utf8");
      await writeFile(destination, "old-state\n", "utf8");

      await replaceFileAtomically(source, destination, "new-state\n", {
        maxRetries: 0,
        renameFile: async (from, to) => {
          await rename(from, to);
          throw Object.assign(new Error("simulated lost replacement acknowledgment"), {
            code: "EPERM"
          });
        }
      });

      expect(await readFile(destination, "utf8")).toBe("new-state\n");
      await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

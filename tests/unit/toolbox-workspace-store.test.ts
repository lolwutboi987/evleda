import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as filesystem from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { createToolboxWorkspaceStore, type ToolboxWorkspaceAllocationInput } from "../../src/mcp/toolbox-workspace-store.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

const owned: string[] = [];
afterEach(async () => {
  vi.mocked(filesystem.opendir).mockReset();
  for (const root of owned.splice(0)) {
    if (!path.isAbsolute(root) || !path.basename(root).startsWith("evleda-workspace-store-")) throw new Error("Unexpected fixture cleanup root.");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "evleda-workspace-store-")); owned.push(parent);
  const workspaceRoot = path.join(parent, "workspace"); await mkdir(workspaceRoot);
  const fixed = path.join(parent, "fixed"); await mkdir(fixed);
  const store = await createToolboxWorkspaceStore({ workspaceRoot, protectedRoots: [fixed] });
  return { parent, workspaceRoot, fixed, store };
}
function input(overrides: Partial<ToolboxWorkspaceAllocationInput> = {}): ToolboxWorkspaceAllocationInput {
  const draft = { kind: "test-only-intent", value: 1 };
  return { projectId: randomUUID(), name: "new-board", originalPrompt: "Make the requested board.",
    draft, draftIdentity: contentIdentity(canonicalJson(draft)), ...overrides };
}
const errorCode = (code: string) => expect.objectContaining({ code });

describe("toolbox workspace allocation", () => {
  it("allocates disjoint fixed paths and reloads immutable draft data across store instances", async () => {
    const { store, workspaceRoot, fixed } = await fixture(); const request = input();
    const allocated = await store.allocate(request);
    expect(allocated).toEqual({ created: true, projectId: request.projectId, name: request.name,
      inputDir: path.join(workspaceRoot, "projects", request.projectId, "input"),
      outputDir: path.join(workspaceRoot, "projects", request.projectId, "output") });
    expect(await readdir(allocated.outputDir)).toEqual([]);
    expect(await readFile(path.join(allocated.inputDir, "draft.json"), "utf8")).toBe(canonicalJson(request.draft));
    const reopened = await createToolboxWorkspaceStore({ workspaceRoot, protectedRoots: [fixed] });
    expect(await reopened.lookup(request.projectId)).toEqual({ projectId: request.projectId, name: request.name,
      inputDir: allocated.inputDir, outputDir: allocated.outputDir, originalPrompt: request.originalPrompt,
      draftIdentity: request.draftIdentity, draft: request.draft });
    expect(await reopened.lookup(randomUUID())).toBeUndefined();
  });

  it("replays the exact allocation without overwriting native output", async () => {
    const { store } = await fixture(); const request = input(); const allocated = await store.allocate(request);
    const board = path.join(allocated.outputDir, "retained.kicad_pcb"); await writeFile(board, "retained");
    expect(await store.allocate(request)).toEqual({ ...allocated, created: false });
    expect(await readFile(board, "utf8")).toBe("retained");
  });

  it.each(["name", "originalPrompt", "draft"] as const)("rejects conflicting %s for an existing ID", async field => {
    const { store } = await fixture(); const request = input(); const allocated = await store.allocate(request);
    const changed = field === "draft" ? { draft: { changed: true }, draftIdentity: contentIdentity(canonicalJson({ changed: true })) }
      : { [field]: field === "name" ? "different-board" : "A different request" };
    await expect(store.allocate({ ...request, ...changed })).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    expect(await readFile(path.join(allocated.inputDir, "draft.json"), "utf8")).toBe(canonicalJson(request.draft));
  });

  it("does not repair or delete an incomplete allocation", async () => {
    const { store, workspaceRoot } = await fixture(); const request = input();
    const project = path.join(workspaceRoot, "projects", request.projectId); await mkdir(project);
    await writeFile(path.join(project, "partial.txt"), "retained");
    await expect(store.lookup(request.projectId)).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    await expect(store.allocate(request)).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    expect(await readdir(project)).toEqual(["partial.txt"]);
  });

  it("detects tampered drafts and manifests", async () => {
    const { store } = await fixture(); const first = input(); const a = await store.allocate(first);
    await writeFile(path.join(a.inputDir, "draft.json"), canonicalJson({ changed: true }));
    await expect(store.lookup(first.projectId)).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    const second = input(); const b = await store.allocate(second);
    const manifest = path.join(path.dirname(b.inputDir), "allocation.json");
    const value = JSON.parse(await readFile(manifest, "utf8")); value.projectId = first.projectId;
    await writeFile(manifest, canonicalJson(value));
    await expect(store.lookup(second.projectId)).rejects.toEqual(errorCode("NEEDS_REVIEW"));
  });

  it("rejects hard-linked records and renamed input directories", async () => {
    const { store, parent } = await fixture(); const first = input(); const a = await store.allocate(first);
    await link(path.join(a.inputDir, "draft.json"), path.join(parent, "shared.json"));
    await expect(store.lookup(first.projectId)).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    const second = input(); const b = await store.allocate(second);
    await rename(b.inputDir, `${b.inputDir}-retained`);
    await expect(store.lookup(second.projectId)).rejects.toEqual(errorCode("NEEDS_REVIEW"));
  });

  it("rejects traversal, invalid names, wrong draft identity, and non-JSON data before allocation", async () => {
    const { store, workspaceRoot } = await fixture();
    for (const projectId of ["../escape", "a/b", randomUUID().toUpperCase()]) {
      await expect(store.allocate(input({ projectId }))).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
    }
    await expect(store.allocate(input({ name: "../escape" }))).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
    await expect(store.allocate(input({ name: " new-board " }))).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
    await expect(store.allocate(input({ draftIdentity: contentIdentity("different") }))).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
    await expect(store.allocate(input({ draft: { value: undefined } }))).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
    await expect(store.allocate(input({ originalPrompt: " " }))).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
    expect(await readdir(path.join(workspaceRoot, "projects"))).toEqual([]);
  });

  it("rejects links and root identity changes without scanning project contents", async () => {
    const { store, parent, workspaceRoot, fixed } = await fixture();
    const alias = path.join(parent, "alias"); await symlink(workspaceRoot, alias, "junction");
    await expect(createToolboxWorkspaceStore({ workspaceRoot: alias, protectedRoots: [fixed] })).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    await rename(workspaceRoot, `${workspaceRoot}-retained`); await mkdir(workspaceRoot);
    await expect(store.allocate(input())).rejects.toEqual(errorCode("NEEDS_REVIEW"));
  });

  it("rejects protected files and directories overlapping the workspace, including missing descendants", async () => {
    const { workspaceRoot, parent } = await fixture();
    for (const protectedRoot of [parent, workspaceRoot, path.join(workspaceRoot, "not-yet-created", "profile.json")]) {
      await expect(createToolboxWorkspaceStore({ workspaceRoot, protectedRoots: [protectedRoot] })).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    }
    const externalProfile = path.join(parent, "profile.json"); await writeFile(externalProfile, "{}");
    await expect(createToolboxWorkspaceStore({ workspaceRoot, protectedRoots: [externalProfile, path.join(parent, "future", "helper.exe")] })).resolves.toBeDefined();
    await expect(createToolboxWorkspaceStore({ workspaceRoot: "relative", protectedRoots: [] })).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
  });

  it("lists a bounded sorted page without returning draft bodies", async () => {
    const { store } = await fixture(); const requests = [input(), input(), input()];
    for (const request of requests) await store.allocate(request);
    const page = await store.list({ offset: 1, limit: 1 });
    expect(page).toMatchObject({ offset: 1, limit: 1, total: 3 });
    expect(page.projects.map(record => record.projectId)).toEqual(requests.map(value => value.projectId).sort().slice(1, 2));
    expect(page.projects[0]).not.toHaveProperty("draft");
    await expect(store.list({ limit: 101 })).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
    await expect(store.list({ offset: -1 })).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
  });

  it("admits the final catalog slot, keeps exact replay at capacity, and rejects the next ID without writing", async () => {
    const { store, workspaceRoot } = await fixture();
    const request = input({ projectId: "00000000-0000-4000-8000-000000000000" });
    // Simulate directory entries only: admission must not inspect unrelated payloads.
    // Real target allocation/lookup/list-page payload and all writes remain on disk.
    let entryCount = 9_999;
    const actualOpendir = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).opendir;
    vi.mocked(filesystem.opendir).mockImplementation(async (...args) => {
      if (args[0] !== path.join(workspaceRoot, "projects")) return actualOpendir(...args);
      return {
        async *[Symbol.asyncIterator]() {
          if (entryCount === 10_000) yield { name: request.projectId, isDirectory: () => true, isSymbolicLink: () => false };
          for (let index = 0; index < 9_999; index++) yield { name: `ffffffff-ffff-4fff-8fff-${index.toString(16).padStart(12, "0")}`,
            isDirectory: () => true, isSymbolicLink: () => false };
        },
      } as Awaited<ReturnType<typeof filesystem.opendir>>;
    });
    expect((await store.allocate(request)).created).toBe(true);
    entryCount = 10_000;
    expect((await store.allocate(request)).created).toBe(false);
    await expect(store.allocate(input())).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    expect(await readdir(path.join(workspaceRoot, "projects"))).toEqual([request.projectId]);
    expect(await readdir(workspaceRoot)).toEqual(["projects"]);
    expect(await store.list({ limit: 1 })).toMatchObject({ total: 10_000, projects: [{ projectId: request.projectId }] });
  });

  it("uses the same invalid-child admission policy as listing without invalidating exact replay", async () => {
    const { store, workspaceRoot } = await fixture(); const request = input(); await store.allocate(request);
    await writeFile(path.join(workspaceRoot, "projects", "unrecognized"), "retained");
    await expect(store.allocate(input())).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    await expect(store.list()).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    expect((await store.allocate(request)).created).toBe(false);
    expect((await readdir(path.join(workspaceRoot, "projects"))).sort()).toEqual([request.projectId, "unrecognized"].sort());
    expect(await readdir(workspaceRoot)).toEqual(["projects"]);
  });

  it("excludes a second store only during admission, cleans the lock, and permits independent project leases", async () => {
    const { store, workspaceRoot, fixed } = await fixture();
    const other = await createToolboxWorkspaceStore({ workspaceRoot, protectedRoots: [fixed] });
    let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
    let proceed!: () => void; const pending = new Promise<void>(resolve => { proceed = resolve; });
    const actual = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).opendir;
    vi.mocked(filesystem.opendir).mockImplementationOnce(async (...args) => {
      entered(); await pending; return actual(...args);
    });
    const first = input(); const second = input();
    const allocating = store.allocate(first);
    try {
      await entering;
      await expect(other.allocate(second)).rejects.toEqual(errorCode("NEEDS_REVIEW"));
      expect(await readdir(path.join(workspaceRoot, "projects"))).toEqual([]);
    } finally { proceed(); }
    await allocating;
    expect(await readdir(workspaceRoot)).toEqual(["projects"]);
    await other.allocate(second);
    const leases = await Promise.all([store.acquireLease(first.projectId), other.acquireLease(second.projectId)]);
    await Promise.all(leases.map(lease => lease.release()));
    expect(await readdir(workspaceRoot)).toEqual(["projects"]);
  });

  it("retains a crash-held admission lock while allowing exact allocation replay", async () => {
    const { store, workspaceRoot } = await fixture(); const request = input(); await store.allocate(request);
    const lock = path.join(workspaceRoot, ".toolbox-admission.json");
    await writeFile(lock, "unconfirmed prior owner");
    expect((await store.allocate(request)).created).toBe(false);
    await expect(store.allocate(input())).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    expect(await readFile(lock, "utf8")).toBe("unconfirmed prior owner");
    expect(await readdir(path.join(workspaceRoot, "projects"))).toEqual([request.projectId]);
  });
});

describe("toolbox workspace leases", () => {
  it("excludes another store until exact-owner release and supports idempotent release", async () => {
    const { store, workspaceRoot, fixed } = await fixture(); const request = input(); await store.allocate(request);
    const other = await createToolboxWorkspaceStore({ workspaceRoot, protectedRoots: [fixed] });
    const lease = await store.acquireLease(request.projectId);
    await expect(other.acquireLease(request.projectId)).rejects.toEqual(errorCode("LEASE_HELD"));
    await lease.release(); await lease.release();
    const next = await other.acquireLease(request.projectId); await next.release();
  });

  it("does not reclaim a preexisting lease regardless of its bytes or PID claims", async () => {
    const { store } = await fixture(); const request = input(); const allocated = await store.allocate(request);
    const leasePath = path.join(path.dirname(allocated.inputDir), ".toolbox-lease.json");
    await writeFile(leasePath, '{"pid":99999999}');
    await expect(store.acquireLease(request.projectId)).rejects.toEqual(errorCode("LEASE_HELD"));
    expect(await readFile(leasePath, "utf8")).toBe('{"pid":99999999}');
  });

  it("retains a modified owned lease on release failure", async () => {
    const { store } = await fixture(); const request = input(); const allocated = await store.allocate(request);
    const lease = await store.acquireLease(request.projectId);
    const leasePath = path.join(path.dirname(allocated.inputDir), ".toolbox-lease.json");
    await writeFile(leasePath, "changed");
    await expect(lease.release()).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    expect(await readFile(leasePath, "utf8")).toBe("changed");
    await expect(store.acquireLease(request.projectId)).rejects.toEqual(errorCode("LEASE_HELD"));
  });

  it("retains a replacement lease even if its bytes match", async () => {
    const { store } = await fixture(); const request = input(); const allocated = await store.allocate(request);
    const lease = await store.acquireLease(request.projectId);
    const leasePath = path.join(path.dirname(allocated.inputDir), ".toolbox-lease.json");
    const bytes = await readFile(leasePath); await rename(leasePath, `${leasePath}-retained`); await writeFile(leasePath, bytes);
    await expect(lease.release()).rejects.toEqual(errorCode("NEEDS_REVIEW"));
    expect(await readFile(leasePath)).toEqual(bytes);
  });

  it("rejects unknown projects and releases concurrent requests only once", async () => {
    const { store } = await fixture(); await expect(store.acquireLease(randomUUID())).rejects.toEqual(errorCode("INVALID_ARGUMENT"));
    const request = input(); await store.allocate(request); const lease = await store.acquireLease(request.projectId);
    await Promise.all([lease.release(), lease.release()]);
    const next = await store.acquireLease(request.projectId); await next.release();
  });
});

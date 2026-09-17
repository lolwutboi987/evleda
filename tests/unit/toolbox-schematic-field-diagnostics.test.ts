import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { captureFreshSchematicFieldError, createFreshSchematicFieldDiagnostic, FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_TIMEOUT_MS,
  publishFreshSchematicFieldDiagnostic, schematicFieldDiagnosticFilename, schematicFieldDiagnosticReferenceText,
  type FreshSchematicFieldDiagnostic } from "../../src/harness/fresh-schematic-field-diagnostics.js";
import { createToolboxSchematicFieldDiagnostics, writeToolboxSchematicFieldDiagnostic } from "../../src/mcp/toolbox-schematic-field-diagnostics.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const root of roots.splice(0)) {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fixture escaped its owned temporary directory.");
    await rm(root, { recursive: true, force: true });
  }
});
async function outputRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-field-diagnostics-")); roots.push(root); return root;
}
function diagnostic(overrides: Partial<Omit<FreshSchematicFieldDiagnostic, "schemaVersion" | "identity">> = {}) {
  return createFreshSchematicFieldDiagnostic({ failureId: "f03d696c-8913-4e27-a094-a0aec151a0e2", phase: "primary-failure",
    toolCallId: "fields-fixture", firstOperation: "sch_autoplace_fields", beforeSchematicContentIdentity: contentIdentity("before"),
    primary: captureFreshSchematicFieldError(new Error("native failure", { cause: { operation: "sch_autoplace_fields",
      response: { isError: true, content: [{ type: "text", text: "Unsupported graphical item 'arc': api_key=private-fixture-token C:/private/source" }] } } })),
    sessionResponse: null, schematicRollback: "not-attempted", rollbackFailure: null, nativeSchematicState: "unproven", nativeClose: null,
    primaryArtifact: null, recoveryArtifact: null, ...overrides });
}
const closeOutcome = { nativeEditorTeardown: "unconfirmed", sidecarTeardown: "confirmed", ownedHostCleanup: "unconfirmed", checkpoint: "not-observed" } as const;

describe("private schematic first-failure artifacts", () => {
  it("writes the complete immutable private cause and advertises only its filename and exact byte identity", async () => {
    const root = await outputRoot(), value = diagnostic();
    const reference = await publishFreshSchematicFieldDiagnostic(value => writeToolboxSchematicFieldDiagnostic(root, value), value);
    expect(reference).not.toBeNull();
    const bytes = await readFile(path.join(root, reference!.filename));
    expect(reference!.identity).toEqual(contentIdentity(bytes));
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(value);
    expect(bytes.toString("utf8")).toContain("Unsupported graphical item 'arc': api_key=private-fixture-token C:/private/source");
    expect(schematicFieldDiagnosticReferenceText("primary", reference)).not.toMatch(/private-fixture-token|C:|Unsupported/);
    expect(Object.isFrozen(value.primary)).toBe(true);
    expect(Object.isFrozen(value.beforeSchematicContentIdentity)).toBe(true);
    await expect(writeToolboxSchematicFieldDiagnostic(root, value)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(root, reference!.filename))).toEqual(bytes);
  });

  it("records rollback and actual teardown independently and never replaces the first artifact", async () => {
    const root = await outputRoot(), lifecycle = createToolboxSchematicFieldDiagnostics(root), primary = diagnostic();
    const first = await lifecycle.observe(primary), bytes = await readFile(path.join(root, first.filename));
    const recovery = diagnostic({ phase: "recovery-finished", schematicRollback: "verified", primaryArtifact: first });
    const recovered = await lifecycle.observe(recovery);
    expect((await readdir(root)).some(file => file.includes("close-finished"))).toBe(false);
    await lifecycle.finalize(closeOutcome);
    await lifecycle.finalize({ ...closeOutcome, nativeEditorTeardown: "confirmed" });
    const final = JSON.parse(await readFile(path.join(root, schematicFieldDiagnosticFilename({ ...primary, phase: "close-finished" })), "utf8"));
    expect(final).toMatchObject({ schematicRollback: "verified", nativeClose: closeOutcome, primaryArtifact: first, recoveryArtifact: recovered });
    expect(final).not.toHaveProperty("workspaceLeaseReleased");
    expect(await readFile(path.join(root, first.filename))).toEqual(bytes);
    expect(await readdir(root)).toHaveLength(3);
    await expect(lifecycle.observe(recovery)).rejects.toThrow(/duplicated or out of order/);
  });

  it("rejects duplicate, out-of-order, foreign and replaced first-failure observations", async () => {
    const root = await outputRoot(), lifecycle = createToolboxSchematicFieldDiagnostics(root), primary = diagnostic();
    await expect(lifecycle.observe(diagnostic({ phase: "recovery-finished" }))).rejects.toThrow(/out of order/);
    await lifecycle.observe(primary);
    await expect(lifecycle.observe(primary)).rejects.toThrow(/duplicated/);
    await expect(lifecycle.observe(diagnostic({ phase: "recovery-finished", failureId: "00000000-0000-0000-0000-000000000000" }))).rejects.toThrow(/first failure/);
    await expect(lifecycle.observe(diagnostic({ phase: "recovery-finished", primary: captureFreshSchematicFieldError(new Error("replacement")) }))).rejects.toThrow(/immutable/);
    expect(await readdir(root)).toHaveLength(1);
  });

  it("rejects identity, schema, phase and filename injection before creating an artifact", async () => {
    const root = await outputRoot(), value = diagnostic();
    await expect(writeToolboxSchematicFieldDiagnostic(root, { ...value, firstOperation: "tampered" })).rejects.toThrow(/identity/);
    const { identity: _identity, ...body } = value;
    for (const changed of [{ ...body, phase: "../elsewhere" }, { ...body, schemaVersion: "wrong" }, { ...body, failureId: "../elsewhere" }]) {
      await expect(writeToolboxSchematicFieldDiagnostic(root, { ...changed, identity: canonicalIdentity(changed, changed.schemaVersion) } as FreshSchematicFieldDiagnostic)).rejects.toThrow();
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("requires an exact physical output directory and refuses existing linked targets", async () => {
    const root = await outputRoot(), value = diagnostic(), filename = schematicFieldDiagnosticFilename(value);
    await expect(writeToolboxSchematicFieldDiagnostic(path.relative(process.cwd(), root), value)).rejects.toThrow(/exact host-owned/);
    await expect(writeToolboxSchematicFieldDiagnostic(`${root}${path.sep}.`, value)).rejects.toThrow(/exact host-owned/);
    const actual = path.join(root, "actual"), alias = path.join(root, "alias");
    await mkdir(actual); await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(writeToolboxSchematicFieldDiagnostic(alias, value)).rejects.toThrow(/exact host-owned/);
    const source = path.join(root, "preserve"); await writeFile(source, "original");
    await link(source, path.join(actual, filename));
    await expect(writeToolboxSchematicFieldDiagnostic(actual, value)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(source, "utf8")).toBe("original");
    expect((await lstat(source)).nlink).toBe(2);
  });

  it("refuses changed physical file identity after writing instead of advertising success", async () => {
    const root = await outputRoot(), value = diagnostic(), target = path.join(root, schematicFieldDiagnosticFilename(value));
    const original = filesystem.lstat;
    vi.spyOn(filesystem, "lstat").mockImplementation((async (...args: Parameters<typeof filesystem.lstat>) => {
      const stat = await original(...args);
      return args[0] === target ? { ...stat, ino: typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1,
        isFile: () => true, isSymbolicLink: () => false } : stat;
    }) as typeof filesystem.lstat);
    await expect(writeToolboxSchematicFieldDiagnostic(root, value)).rejects.toThrow(/artifact identity changed/);
    expect(await readFile(target, "utf8")).toBe(`${canonicalJson(value)}\n`);
  });

  it("rejects invented public receipts and never executes foreign accessors while capturing a cause", async () => {
    const value = diagnostic();
    expect(await publishFreshSchematicFieldDiagnostic(async () => ({ filename: schematicFieldDiagnosticFilename(value), identity: contentIdentity("different") }), value)).toBeNull();
    const getter = vi.fn(() => { throw new Error("must not run"); });
    const foreign = Object.defineProperty({}, "secret", { enumerable: true, get: getter });
    expect(captureFreshSchematicFieldError(foreign).status).toBe("unavailable");
    expect(getter).not.toHaveBeenCalled();
    expect(captureFreshSchematicFieldError(new Proxy({}, { ownKeys: getter })).status).toBe("unavailable");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["reject", "timeout"] as const)("keeps close bounded when its diagnostic writer encounters %s", async mode => {
    const root = await outputRoot();
    const writer = vi.fn(writeToolboxSchematicFieldDiagnostic);
    const lifecycle = createToolboxSchematicFieldDiagnostics(root, writer);
    await lifecycle.observe(diagnostic());
    writer.mockImplementationOnce(async () => {
      if (mode === "reject") throw new Error("private write fault");
      return await new Promise(() => {});
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closed = lifecycle.finalize(closeOutcome);
    await vi.advanceTimersByTimeAsync(FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_TIMEOUT_MS);
    await expect(closed).resolves.toBeUndefined();
    expect(await readdir(root)).toHaveLength(1);
  });
});

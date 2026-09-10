import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { bindKicadStartupEvidence, captureKicadStartupCause, captureKicadStartupFailure, withKicadStartupCleanup } from "../../src/integrations/kicad-startup-diagnostic.js";
import { createToolboxStartupDiagnostic, writeToolboxStartupDiagnostic } from "../../src/mcp/toolbox-startup-diagnostics.js";

const roots: string[] = [];
afterEach(async () => {
  const temporaryRoot = await realpath(tmpdir());
  for (const root of roots.splice(0)) {
    const target = await realpath(root);
    if (path.dirname(target) !== temporaryRoot || !path.basename(target).startsWith("startup-diag-")) throw new Error("Startup diagnostic test cleanup escaped its owned temporary directory.");
    await rm(target, { recursive: true, force: true });
  }
});
describe("safe startup cause capture", () => {
  it("retains allowlisted OS and numeric protocol codes without foreign prose", () => {
    const os = Object.assign(new Error("sk-secret C:/private/env"), { code: "EACCES", errno: -13, exitCode: 2 });
    expect(captureKicadStartupCause(os)).toEqual({ category: "native-error", code: "EACCES", errno: -13, exitCode: 2 });
    expect(captureKicadStartupCause(Object.assign(new Error("native-token"), { code: -32602 }))).toEqual({ category: "native-error", code: -32602 });
    expect(captureKicadStartupCause(Object.assign(new Error("native-token"), { code: "sk-secret", errno: Infinity }))).toEqual({ category: "native-error" });
  });
  it("does not invoke getters, conversion hooks, inspectors or proxy traps", () => {
    let invoked = 0;
    const forbidden = () => { invoked++; throw new Error("foreign hook invoked"); };
    const error = new Error("sk-secret");
    for (const key of ["name", "message", "cause", "code", "errno", "exitCode", "toJSON", "toString", inspect.custom]) Object.defineProperty(error, key, { get: forbidden });
    const captured = captureKicadStartupFailure(error, "mcp-handshake");
    const proxy = new Proxy({}, { get: forbidden, getPrototypeOf: forbidden, ownKeys: forbidden, getOwnPropertyDescriptor: forbidden });
    expect(captureKicadStartupCause(proxy)).toEqual({ category: "foreign-value" });
    expect(invoked).toBe(0);
    expect(inspect(captured)).not.toContain("sk-secret");
    expect(JSON.stringify(captured)).not.toContain("foreign hook");
  });
  it("preserves the first stage and cause across bridge and cleanup wrappers", () => {
    const first = captureKicadStartupFailure(Object.assign(new Error("private"), { code: "ECONNREFUSED" }), "mcp-handshake", { category: "present", truncated: false, seenBytes: 149 });
    const wrapper = bindKicadStartupEvidence(new Error("static"), first);
    const again = captureKicadStartupFailure(wrapper, "bridge-connect");
    const final = withKicadStartupCleanup(again, "bridge-cleanup", "unconfirmed", Object.assign(new Error("secondary secret"), { code: "EPERM" }));
    expect(final.failure).toBe(first.failure);
    expect(first.cleanup).toEqual([]);
    expect(final.cleanup).toEqual([{ stage: "bridge-cleanup", status: "unconfirmed", cause: { category: "native-error", code: "EPERM" } }]);
    expect(Object.isFrozen(final.failure.cause)).toBe(true);
  });
});
describe("immutable startup diagnostic artifacts", () => {
  it("saves primary and cleanup records independently with verified content identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "startup-diag-")); roots.push(root);
    const first = captureKicadStartupFailure(Object.assign(new Error("private-token"), { code: "ENOENT" }), "session-launcher");
    const primary = createToolboxStartupDiagnostic("primary-failure", first);
    const finalized = createToolboxStartupDiagnostic("cleanup-finished", withKicadStartupCleanup(first, "host-cleanup", "unconfirmed"));
    const one = await writeToolboxStartupDiagnostic(root, primary), two = await writeToolboxStartupDiagnostic(root, finalized);
    expect(one.filename).not.toBe(two.filename);
    const bytes = await readFile(path.join(root, one.filename));
    expect(contentIdentity(bytes)).toEqual(one.identity);
    expect(JSON.parse(bytes.toString())).toEqual(primary);
    expect(bytes.toString()).not.toContain("private-token");
    expect(await readdir(root)).toHaveLength(2);
    await expect(writeToolboxStartupDiagnostic(root, { ...primary, phase: "cleanup-finished" })).rejects.toThrow("identity");
    expect(await readdir(root)).toHaveLength(2);
  });
});

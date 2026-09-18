import { readFile, writeFile, access, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createKicadToolboxWorkspace } from "../../src/mcp/toolbox-workspace.js";
import type { FreshNativeToolboxBinding } from "../../src/mcp/toolbox-fresh-main.js";
import { contentIdentity, canonicalJson } from "../../src/core/canonical.js";
import { qualifyRuntimeSourceImport, executeQualifiedRuntimeSourceImport, releaseQualifiedRuntimeSourceImport,
  type QualifiedRuntimeSourceImport } from "../../src/mcp/toolbox-runtime-source-import.js";
import { captureReadonlyPlaneRuntimeImportSource, assertReadonlyPlaneRuntimeImportSourceCurrent, readReadonlyPlaneRuntimeImportSource,
  isVerifiedFreshProject } from "../../src/harness/fresh-project.js";
import { runtimeSourceImportFixture } from "../helpers/runtime-source-import.js";
import { resumeKicadToolboxPlaneProject } from "../../src/mcp/toolbox-plane-preparation.js";
import { prepareRuntimeSourceImportStore } from "../../scripts/import-toolbox-runtime-source.js";

const fixtures: Awaited<ReturnType<typeof runtimeSourceImportFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
const fixture = async () => { const f = await runtimeSourceImportFixture(); fixtures.push(f); return f; };
const oldArtifacts = async (f: Awaited<ReturnType<typeof fixture>>) => Promise.all(Object.values(f.sourcePaths).map(file => readFile(file)));

describe("trusted administration runtime source import", () => {
  it.each(["runtime", "missing-source"])("rejects a %s workspace before creating any project directory", async kind => {
    const f = await fixture(), selectedRoot = kind === "runtime" ? f.runtimeData[0]!.root : path.join(f.root, "missing-workspace");
    if (kind === "missing-source") await mkdir(selectedRoot);
    const before = await readdir(selectedRoot);
    const request = { ...f.request, workspaceRoot: selectedRoot }, admin = await f.pin(path.join(f.root, "admin.json"), request);
    await expect(prepareRuntimeSourceImportStore(request, admin, { loadDesign: f.dependencies.loadDesignProfile!, readNative: async input => {
      const profile = await f.dependencies.readNativeProfile!(input);
      return { ...profile, path: input.path, kicadToolchain: { ...profile.kicadToolchain, binRoot: path.join(f.root, "separate-kicad-bin") }, kicadMcpRuntime: { ...profile.kicadMcpRuntime,
        lock: { path: f.profile.path, identity: f.profile.contentIdentity }, runtimeParentRoot: path.join(f.root, "private-runtime"), ipcSocketParentRoot: path.join(f.root, "private-ipc") } };
    } })).rejects.toThrow(kind === "runtime" ? /overlaps/ : /ENOENT/);
    expect(await readdir(selectedRoot)).toEqual(before);
    await expect(access(path.join(selectedRoot, "projects"))).rejects.toThrow();
  });

  it("captures a genuine read-only source without reconciling or granting old-source write authority", async () => {
    const f = await fixture(), before = await oldArtifacts(f), pins = structuredClone(f.request.sourcePins);
    await expect(captureReadonlyPlaneRuntimeImportSource({ outputDir: f.source.allocation.outputDir, name: "seeded", compilationBundle: f.source.preparation.bundle,
      pins: { ...pins, bundle: { ...pins.bundle, digest: "0".repeat(64) } } })).rejects.toThrow(/authenticated bundle/);
    let bundleReads = 0;
    const capturedPromise = captureReadonlyPlaneRuntimeImportSource({ outputDir: f.source.allocation.outputDir, name: "seeded",
      get compilationBundle() { bundleReads++; return f.source.preparation.bundle; }, pins });
    pins.sch.digest = "0".repeat(64);
    const source = await capturedPromise;
    expect(bundleReads).toBe(1); expect(isVerifiedFreshProject(source)).toBe(false);
    expect(readReadonlyPlaneRuntimeImportSource(source, "sch")).toBe(f.source.bytes);
    await assertReadonlyPlaneRuntimeImportSourceCurrent(source);
    expect(await oldArtifacts(f)).toEqual(before);
    expect(() => readReadonlyPlaneRuntimeImportSource({ ...source }, "sch")).toThrow(/not genuine/);
    await writeFile(f.source.preparation.project.unsafeTerminalPath, "{}");
    await expect(assertReadonlyPlaneRuntimeImportSourceCurrent(source)).rejects.toThrow(/unsafe/);
  });

  it("reissues exact source through new Open/normal finish, persists distinct custody and resumes the target", async () => {
    const f = await fixture(), before = await oldArtifacts(f);
    const qualified = await qualifyRuntimeSourceImport(f.request, f.store, f.dependencies);
    expect(qualified.lineage.nativeEvidenceTransferred).toBe(false);
    expect(Object.isFrozen(qualified.lineage.targetProfile.contentIdentity)).toBe(true);
    await expect(f.store.acquireLease(f.source.projectId)).rejects.toMatchObject({ code: "LEASE_HELD" });
    const result = await executeQualifiedRuntimeSourceImport(qualified);
    expect(result).toMatchObject({ status: "imported", projectId: f.request.targetProjectId, nativeEvidenceTransferred: false });
    expect(f.calls.filter(call => ["open-new", "normal-close"].includes(call))).toEqual(["open-new", "normal-close"]);
    const target = (await f.store.lookup(f.request.targetProjectId))!;
    expect(target.runtimeSourceImportLineage).toEqual(qualified.lineage); expect(target.schematicSeedLineage).toBeUndefined();
    expect(await readFile(path.join(target.outputDir, "project/seeded.kicad_sch"), "utf8")).toBe(f.source.bytes);
    const custody = JSON.parse(await readFile(path.join(target.outputDir, "runtime-source-import-custody.json"), "utf8"));
    expect(custody).toMatchObject({ status: "new-target-normally-closed", nativeEvidenceTransferred: false });
    expect(await oldArtifacts(f)).toEqual(before);
    const sourceLease = await f.store.acquireLease(f.source.projectId); await sourceLease.release();
    const targetLease = await f.store.acquireLease(target.projectId); await targetLease.release();
    const resumed = await resumeKicadToolboxPlaneProject({ outputDir: target.outputDir, name: target.name, dependencies: f.compilerDependencies,
      expectedKicadCli: f.expectedKicadCli, createKicadCliAdapter: f.createKicadCliAdapter });
    expect(await readFile(resumed.project.schematicPath, "utf8")).toBe(f.source.bytes);
    await expect(executeQualifiedRuntimeSourceImport(qualified)).rejects.toThrow(/consumed/);
    const retry = await qualifyRuntimeSourceImport(f.request, f.store, f.dependencies);
    expect(await executeQualifiedRuntimeSourceImport(retry)).toMatchObject({ status: "already_created", projectId: target.projectId });
    await expect(f.store.allocate({ ...target, runtimeSourceImportLineage: undefined } as any)).rejects.toThrow(/conflicting/);
  });

  it("rejects forged and copied host capabilities; permits explicit unused-authority release", async () => {
    const f = await fixture(), qualified = await qualifyRuntimeSourceImport(f.request, f.store, f.dependencies);
    await expect(executeQualifiedRuntimeSourceImport({ ...qualified })).rejects.toThrow(/forged/);
    await expect(executeQualifiedRuntimeSourceImport({ kind: "qualified-plane-runtime-source-import" } as QualifiedRuntimeSourceImport)).rejects.toThrow(/forged/);
    await releaseQualifiedRuntimeSourceImport(qualified);
    const lease = await f.store.acquireLease(f.source.projectId); await lease.release();
    expect((await f.store.list()).total).toBe(1);
  });

  it.each(["libraries", "KiCad", "policy", "launch-flags", "launch-count", "bytecode"])("rejects an unrelated target profile %s change before any target allocation", async field => {
    const f = await fixture(), changed = structuredClone(f.profiles[1]!.data) as any;
    if (field === "libraries") changed.libraries.stock = "different library sources";
    else if (field === "KiCad") changed.kicadToolchain.kicadCli.operationalVersion = "10.0.4";
    else if (field === "policy") changed.policy.edit = false;
    else if (field === "launch-flags") changed.kicadMcpRuntime.runtimePolicy.pythonLaunch.flags = ["-I", "-s", "-E"];
    else if (field === "launch-count") changed.kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentCount = 6;
    else changed.kicadMcpRuntime.runtimePolicy.pythonLaunch.bytecodeWrites = "enabled";
    const targetProfile = await f.pin(f.request.targetProfile.path, changed);
    const proof = { ...f.proof, targetProfile: f.published(targetProfile) };
    const runtimeQualification = await f.pin(f.request.runtimeQualification.path, proof);
    await expect(qualifyRuntimeSourceImport({ ...f.request, targetProfile, runtimeQualification }, f.store, f.dependencies)).rejects.toThrow(/profile policy/);
    expect((await f.store.list()).total).toBe(1); expect(f.calls).not.toContain("open-new");
  });

  it.each(["source", "proof", "library", "allocation", "runtime"])("rejects %s drift after qualification and retains uncertain source ownership", async kind => {
    const f = await fixture(), qualified = await qualifyRuntimeSourceImport(f.request, f.store, f.dependencies);
    const file = kind === "source" ? f.sourcePaths.sch : kind === "proof" ? f.request.runtimeQualification.path
      : kind === "library" ? path.join(f.symbolRoot, "Device.kicad_sym") : kind === "allocation" ? path.join(f.source.allocation.inputDir, "draft.json")
      : path.join(f.runtimeData[0]!.root, "environment/Lib/site-packages/kicad_mcp/tools/schematic.py");
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from(" ")]));
    await expect(executeQualifiedRuntimeSourceImport(qualified)).rejects.toThrow();
    expect(f.calls).not.toContain("open-new"); expect(await f.store.lookup(f.request.targetProjectId)).toBeUndefined();
    if (kind === "source") await expect(f.store.acquireLease(f.source.projectId)).rejects.toMatchObject({ code: "LEASE_HELD" });
    if (kind === "allocation") await expect(access(path.join(f.workspaceRoot, "projects", f.source.projectId, ".toolbox-lease.json"))).resolves.toBeUndefined();
  });

  it("rejects a contradictory qualified report even when the host pin is refreshed", async () => {
    const f = await fixture(), report = structuredClone(f.report); Object.assign(report.targetSummary, { pinMismatches: 1 });
    const reportPin = await f.pin(f.proof.qualification.report.path, report);
    const proof = { ...f.proof, qualification: { ...f.proof.qualification, report: f.published(reportPin) } };
    const runtimeQualification = await f.pin(f.request.runtimeQualification.path, proof);
    await expect(qualifyRuntimeSourceImport({ ...f.request, runtimeQualification }, f.store, f.dependencies)).rejects.toThrow(/summaries/);
  });

  it("does not treat stale close/session custody as a successful current-profile close", async () => {
    const f = await fixture(), session = JSON.parse(await readFile(f.request.normalClose.session.path, "utf8"));
    session.serverArgs[1] = f.request.targetProfile.path;
    const altered = await f.pin(f.request.normalClose.session.path, session);
    await expect(qualifyRuntimeSourceImport({ ...f.request, normalClose: { ...f.request.normalClose, session: altered } }, f.store, f.dependencies)).rejects.toThrow(/another profile/);
  });

  it("does not publish success custody after a target schematic drift that normal close could checkpoint", async () => {
    const f = await fixture(), qualified = await qualifyRuntimeSourceImport(f.request, f.store, f.dependencies);
    f.setOnOpen(async target => { await writeFile(target.project.schematicPath, f.source.bytes + "\n"); });
    await expect(executeQualifiedRuntimeSourceImport(qualified)).rejects.toThrow(/did not complete/);
    const target = (await f.store.lookup(f.request.targetProjectId))!;
    await expect(access(path.join(target.outputDir, "runtime-source-import-custody.json"))).rejects.toThrow();
    await expect(f.store.acquireLease(target.projectId)).rejects.toMatchObject({ code: "LEASE_HELD" });
    expect(f.calls).toContain("normal-close");
  });

  it.each(["wired", "materialized"])("rejects a normally checkpointed %s source", async kind => {
    const f = await fixture();
    if (kind === "wired") await writeFile(f.sourcePaths.sch, f.source.bytes.replace("(embedded_fonts no)", "(embedded_fonts no) (wire)"));
    else await writeFile(f.sourcePaths.pcb, (await readFile(f.sourcePaths.pcb, "utf8")).replace(/\)\s*$/u, '(footprint "Test:Extra" (layer "F.Cu") (at 1 1) (property "Reference" "X1"))\n)'));
    // The real close guard itself may reject a materialized source's changed
    // physical semantics; either boundary must fail before import allocation.
    if (kind === "wired") {
      await f.recloseSource();
      await expect(qualifyRuntimeSourceImport(f.request, f.store, f.dependencies)).rejects.toThrow(/root forms|unwired/i);
    } else {
      await f.source.preparation.project.checkpointAfterReport(f.source.preparation.reportPath, "needs_review");
      for (const key of ["pcb", "checkpoint"] as const) f.request.sourcePins[key] = contentIdentity(await readFile(f.sourcePaths[key]));
      await expect(qualifyRuntimeSourceImport(f.request, f.store, f.dependencies)).rejects.toThrow(/unmaterialized/);
    }
    expect(await f.store.lookup(f.request.targetProjectId)).toBeUndefined(); expect(f.calls).not.toContain("open-new");
  });

  it("closes an unused native target even when proof drift and recovery-marker failure coincide", async () => {
    const f = await fixture(), qualified = await qualifyRuntimeSourceImport(f.request, f.store, f.dependencies);
    f.failRecovery(); f.setOnOpen(async () => { await writeFile(f.request.runtimeQualification.path, "stale proof"); });
    await expect(executeQualifiedRuntimeSourceImport(qualified)).rejects.toThrow(/did not complete/);
    expect(f.calls.filter(call => call === "normal-close")).toHaveLength(1);
    await expect(f.store.acquireLease(f.request.targetProjectId)).rejects.toMatchObject({ code: "LEASE_HELD" });
    const sourceLease = await f.store.acquireLease(f.source.projectId); await sourceLease.release();
  });

  it("public resume refuses the source profile before opening and admits only the qualified target profile", async () => {
    const f = await fixture(), qualified = await qualifyRuntimeSourceImport(f.request, f.store, f.dependencies);
    await executeQualifiedRuntimeSourceImport(qualified); const opens: string[] = [];
    for (const targetProfile of [false, true]) {
      const workspace = createKicadToolboxWorkspace({ profile: targetProfile ? f.request.targetProfile : f.request.sourceProfile,
        store: f.store, dependencies: f.compilerDependencies, access: "edit", openBinding: async options => {
          opens.push(options.profile.path); expect(options.resume).toBe(true);
          return { access: "edit", compoundContractIdentity: f.source.preparation.bundle.contract.identity, designContext: () => ({ family: "plane-v2" }),
            cad: { tools: { tools: [] }, assertCurrent: async () => {}, captureSources: async () => "same", close: async () => {}, prepareCheckpoint: async () => async () => {} } } as unknown as FreshNativeToolboxBinding;
        } });
      const client = new Client({ name: "runtime-import-resume-test", version: "1" }), [left, right] = InMemoryTransport.createLinkedPair();
      await workspace.server.connect(right); await client.connect(left);
      try {
        const result = await client.callTool({ name: "evleda_resume_project", arguments: { projectId: f.request.targetProjectId } });
        if (!targetProfile) { expect(result.isError).toBe(true); expect(opens).toHaveLength(0); }
        else { expect(result.isError).not.toBe(true); expect(result.structuredContent).toMatchObject({ status: "opened", runtimeSourceImportLineage: { nativeEvidenceTransferred: false } });
          expect((await client.callTool({ name: "evleda_design_context", arguments: {} })).structuredContent).toMatchObject({ runtimeSourceImportLineage: { nativeEvidenceTransferred: false } }); }
      } finally { await client.close(); await workspace.close(); }
    }
    expect(opens).toEqual([f.request.targetProfile.path]);
  });
});

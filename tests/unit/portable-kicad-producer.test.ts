import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  portableCanonicalIdentity,
  portableContentIdentity,
  type ToolContentIdentityV1,
} from "../../src/core/portable-artifact.js";
import { TOOL_INVOCATION_RECORD_SCHEMA_VERSION } from "../../src/domain/invocation-ledger.js";
import { projectNativeProcessPlanV2ToLegacyV1 } from "../../src/domain/native-process-plan.js";
import type { NativeProcessPlanV2, ToolInvocationRecord } from "../../src/domain/types.js";
import {
  BoundedProcessError,
  ProcessOutputLimitError,
  ProcessTimeoutError,
  type BoundedProcessOptions,
  type BoundedProcessResult,
  type BoundedProcessRunner,
} from "../../src/integrations/bounded-process.js";
import {
  PortableKicadProducerV3,
  buildKicadBackendRequestV3,
  consumeKicadBackendResultV3,
  type PrivatePortableKicadExecutionOperationV3,
} from "../../src/integrations/portable-kicad-producer.js";
import {
  PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1,
  REVIEWED_KICAD_D356_REV_A_PROFILE_V1,
  buildPortableKicadCommandPlanV1,
  buildPortableKicadNativeProcessPlanV2,
  type PortableKicadCommandKindV1,
  type ResolvedPrivateKicadInvocationV2,
} from "../../src/integrations/portable-kicad-runtime.js";
import { parseCanonicalPrivateKicadFullResultV1Bytes } from "../../src/persistence/private-kicad-capture-store.js";

const roots: string[] = [];
const KINDS = [
  "kicad_erc",
  "kicad_drc",
  "kicad_netlist",
  "kicad_stats",
  "kicad_d356",
  "kicad_pdf",
] as const satisfies readonly PortableKicadCommandKindV1[];
const STAGE = "manufacturing_package" as const;
const SOURCE_REVISION = "a".repeat(64);
const STARTED_AT = "2026-09-05T12:00:00.000Z";
const COMPLETED_AT = "2026-09-05T12:00:01.000Z";

const tool = (role: ToolContentIdentityV1["role"], name: string): ToolContentIdentityV1 => ({
  schemaVersion: "evleda.tool-content-identity.v1",
  role,
  kind: role === "native_validator" ? "native_executable" : "portable_implementation",
  name,
  version: role === "native_validator" ? "10.0.3" : "2.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  contentIdentity: portableContentIdentity(`${name}:content`),
  capabilitiesIdentity: portableContentIdentity(`${name}:capabilities`),
  helpIdentity: portableContentIdentity(`${name}:help`),
});

const nativeTool = tool("native_validator", "kicad-cli");
const normalizerTool = tool("portable_normalizer", "evleda-portable-normalizer");

const pathRef = (
  root: "run_input" | "run_private",
  relativePath: string,
) => ({ schemaVersion: "evleda.portable-path-ref.v1" as const, root, relativePath });

const dummyCanonical = (name: string, schemaVersion: string) =>
  portableCanonicalIdentity({ name }, schemaVersion);

const pendingInvocation = (
  kind: PortableKicadCommandKindV1,
  plan: NativeProcessPlanV2,
): ToolInvocationRecord => {
  const inputManifest = dummyCanonical("input", "evleda.test-input-manifest.v1");
  return {
    schemaVersion: TOOL_INVOCATION_RECORD_SCHEMA_VERSION,
    transport: "native_process",
    id: `invocation_${kind}`,
    projectId: "project_portable_v3",
    runId: "run_portable_v3",
    attemptId: "attempt_portable_v3",
    stage: STAGE,
    fencingEpoch: 1,
    inputManifest,
    executionFence: {
      inputManifest,
      parentRevisionId: "revision_parent",
      parentRevisionManifest: dummyCanonical("parent", "evleda.test-revision.v1"),
      projectHeadRevisionId: "revision_parent",
      requirementsApprovalId: "approval_portable_v3",
      requirementsApprovalDigest: "b".repeat(64),
      nativeProcessPlanBindings: [{
        schemaVersion: "evleda.native-process-plan-binding.v3",
        profileDomain: "kicad",
        operation: kind,
        contractIdentity: plan.profile.contractIdentity,
        planIdentity: plan.planIdentity,
        portableReceiptPlanIdentityV1: projectNativeProcessPlanV2ToLegacyV1(plan).planIdentity,
      }],
    },
    toolContentIdentity: plan.tool.contentIdentity,
    commandPlan: plan,
    commandPlanIdentity: plan.planIdentity,
    stdoutIdentity: null,
    stderrIdentity: null,
    exitCode: null,
    outcome: "unknown",
    startedAt: STARTED_AT,
    completedAt: null,
    invocationIdentity: null,
    portableReceiptInvocationIdentityV1: null,
    portableReceiptInvocationIdentityDisposition: "compatibility_projection_only",
  };
};

const privateResolution = (
  kind: PortableKicadCommandKindV1,
  plan: NativeProcessPlanV2,
  sourcePath: string,
  outputPath: string,
  sourceBytes: Uint8Array,
): ResolvedPrivateKicadInvocationV2 => {
  if (plan.command.kind !== "portable_typed_command_v1") throw new Error("unexpected plan");
  const args = plan.command.value.argv.map((argument) =>
    argument.kind === "literal"
      ? argument.value
      : argument.value.root === "run_private"
        ? outputPath
        : sourcePath);
  const result = Object.create(null) as ResolvedPrivateKicadInvocationV2;
  Object.defineProperties(result, {
    schemaVersion: { value: "evleda.private-resolved-kicad-invocation.v2", enumerable: true },
    disposition: { value: "private-runtime-only", enumerable: true },
    commandKind: { value: kind, enumerable: true },
    acceptedExitCodes: { value: plan.acceptedExitCodes, enumerable: true },
    timeoutMs: { value: plan.timeoutMs, enumerable: true },
    maxStdoutBytes: { value: plan.maxStdoutBytes, enumerable: true },
    maxStderrBytes: { value: plan.maxStderrBytes, enumerable: true },
    nativeProcessPlanIdentity: { value: plan.planIdentity, enumerable: true },
    commandPlanIdentity: { value: plan.command.value.commandPlanIdentity, enumerable: true },
    invocationInputSourceIdentity: { value: portableContentIdentity(sourceBytes), enumerable: true },
    command: { value: path.join(path.dirname(sourcePath), "kicad-cli.exe"), enumerable: false },
    argv: { value: Object.freeze(args), enumerable: false },
    cwd: { value: path.dirname(sourcePath), enumerable: false },
    environment: { value: Object.freeze({ LANG: "C", TZ: "UTC" }), enumerable: false },
    expectedOutputPaths: { value: Object.freeze([outputPath]), enumerable: false },
    expectedOutputs: {
      value: Object.freeze([{ path: outputPath, maxBytes: plan.expectedOutputs[0]!.maxBytes }]),
      enumerable: false,
    },
  });
  return Object.freeze(result);
};

interface OperationFixture {
  readonly operation: PrivatePortableKicadExecutionOperationV3;
  readonly sourcePath: string;
  readonly outputPath: string;
}

const shareExecutionFence = (fixtures: readonly OperationFixture[]): readonly OperationFixture[] => {
  const bindings = fixtures.map(({ operation }) => ({
    schemaVersion: "evleda.native-process-plan-binding.v3" as const,
    profileDomain: "kicad" as const,
    operation: operation.commandKind,
    contractIdentity: operation.nativeProcessPlan.profile.contractIdentity,
    planIdentity: operation.nativeProcessPlan.planIdentity,
    portableReceiptPlanIdentityV1: projectNativeProcessPlanV2ToLegacyV1(
      operation.nativeProcessPlan,
    ).planIdentity,
  }));
  const commonFence = {
    ...fixtures[0]!.operation.pendingInvocation.executionFence,
    nativeProcessPlanBindings: bindings,
  };
  return fixtures.map((fixture) => ({
    ...fixture,
    operation: {
      ...fixture.operation,
      pendingInvocation: {
        ...fixture.operation.pendingInvocation,
        executionFence: commonFence,
      },
    },
  }));
};

const createOperation = async (
  root: string,
  kind: PortableKicadCommandKindV1,
  sourceBytes: Uint8Array,
): Promise<OperationFixture> => {
  const spec = PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[kind];
  const directory = path.join(root, kind);
  await mkdir(directory, { recursive: true });
  const sourcePath = path.join(directory, `design${spec.sourceSuffix}`);
  const outputPath = path.join(directory, `capture${spec.outputSuffix}`);
  await writeFile(sourcePath, sourceBytes);
  const logicalSource = pathRef("run_input", `${spec.sourceSnapshotPrefix}/case/design${spec.sourceSuffix}`);
  const logicalOutput = pathRef("run_private", `${spec.privateOutputPrefix}/case/capture${spec.outputSuffix}`);
  const d356Profile = kind === "kicad_d356" ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1 : undefined;
  const commandPlan = buildPortableKicadCommandPlanV1({
    commandKind: kind,
    tool: nativeTool,
    logicalCwd: pathRef("run_input", path.posix.dirname(logicalSource.relativePath)),
    sourcePath: logicalSource,
    outputPath: logicalOutput,
    ...(d356Profile === undefined ? {} : { d356Profile }),
  });
  const nativeProcessPlan = buildPortableKicadNativeProcessPlanV2({
    commandKind: kind,
    commandPlan,
    ...(d356Profile === undefined ? {} : { d356Profile }),
  });
  return {
    operation: {
      commandKind: kind,
      nativeProcessPlan,
      pendingInvocation: pendingInvocation(kind, nativeProcessPlan),
      resolution: privateResolution(kind, nativeProcessPlan, sourcePath, outputPath, sourceBytes),
    },
    sourcePath,
    outputPath,
  };
};

const loadRawFixtures = async (): Promise<Readonly<Record<PortableKicadCommandKindV1, Buffer>>> => {
  const vectors = JSON.parse(await readFile(
    new URL("../fixtures/portable-artifact-canonical-v1.json", import.meta.url),
    "utf8",
  )) as Record<string, any>;
  return Object.freeze({
    kicad_erc: Buffer.from(vectors.directVolatileErc.rawA, "utf8"),
    kicad_drc: Buffer.from(vectors.directVolatileDrc.rawA, "utf8"),
    kicad_netlist: Buffer.from(vectors.directVolatileNetlist.rawA, "utf8"),
    kicad_stats: Buffer.from(vectors.directVolatileStats.rawA, "utf8"),
    kicad_d356: await readFile(new URL(
      "../../reference-designs/robotics-controller-v0/validation/runs/20260905T041400.496613Z-8b7f124253b42c31/outputs/board-netlist.d356",
      import.meta.url,
    )),
    kicad_pdf: Buffer.from("%PDF-1.7\nprivate candidate drawing\n", "ascii"),
  });
};

const successfulResult = (
  options: BoundedProcessOptions,
  exitCode = 0,
): BoundedProcessResult => ({
  command: options.command,
  args: [...options.args],
  cwd: options.cwd,
  exitCode,
  stdout: "",
  stderr: "",
  durationMs: 1,
  startedAt: STARTED_AT,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Portable KiCad producer v3", () => {
  it("executes the exact six-operation matrix and returns only identity-bound public evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-portable-kicad-v3-"));
    roots.push(root);
    const raw = await loadRawFixtures();
    const revAPcb = await readFile(new URL(
      "../../reference-designs/robotics-controller-v0/robotics-controller-v0.kicad_pcb",
      import.meta.url,
    ));
    const schematicBytes = Buffer.from("shared schematic source snapshot\n");
    const fixtures = shareExecutionFence(await Promise.all(KINDS.map((kind) => createOperation(
      root,
      kind,
      ["kicad_drc", "kicad_stats", "kicad_d356"].includes(kind)
        ? revAPcb
        : schematicBytes,
    ))));
    const outputByPath = new Map(fixtures.map((fixture) => [
      fixture.outputPath,
      raw[fixture.operation.commandKind],
    ]));
    const runner: BoundedProcessRunner = async (options) => {
      const outputPath = options.args.at(-2)!;
      await writeFile(outputPath, outputByPath.get(outputPath)!);
      return successfulResult(options);
    };
    const request = buildKicadBackendRequestV3({
      stage: STAGE,
      expectedSourceRevisionDigest: SOURCE_REVISION,
      operations: fixtures.map((fixture) => fixture.operation).reverse(),
    });
    const producer = new PortableKicadProducerV3({ runner, now: () => COMPLETED_AT });
    const execution = await producer.execute({
      publicRequest: request,
      normalizer: normalizerTool,
      operations: fixtures.map((fixture) => fixture.operation).reverse(),
    });

    expect(execution.publicResult.operations.map((entry) => entry.commandKind)).toEqual(KINDS);
    expect(execution.publicResult.operations.filter((entry) => entry.status === "portable_semantics_created"))
      .toHaveLength(5);
    expect(execution.publicResult.operations.at(-1)).toMatchObject({
      commandKind: "kicad_pdf",
      status: "private_pdf_not_run_publicly",
      marker: { status: "NOT_RUN", portableSemantics: null, rawContentIdentity: null },
      hostAuthenticated: false,
      manufactureReady: false,
      releaseAuthorized: false,
    });
    expect(execution.privateDrafts).toHaveLength(6);
    for (const draft of execution.privateDrafts) {
      expect(draft.disposition).toBe("detached-private-capture-draft");
      if (draft.disposition !== "detached-private-capture-draft") throw new Error("unexpected draft");
      expect(draft.terminalInvocation.outcome).toBe("succeeded");
      expect(draft.compoundVerification).toMatchObject({
        authority: "consistency-only",
        hostAuthenticated: false,
        consistent: true,
        releaseAuthorized: false,
      });
      expect(parseCanonicalPrivateKicadFullResultV1Bytes(draft.files.fullResult))
        .toEqual(draft.fullResult);
    }
    const publicJson = JSON.stringify(execution.publicResult);
    expect(publicJson).not.toContain(root);
    for (const forbidden of ["\"argv\"", "\"cwd\"", "\"stdout\"", "\"stderr\"", "executablePath", "startedAt", "completedAt", "capturedAt"]) {
      expect(publicJson).not.toContain(forbidden);
    }
    expect(consumeKicadBackendResultV3(execution.publicResult, request, execution.privateDrafts))
      .toEqual(execution.publicResult);
  });

  it.each([
    ["spawn", "spawn", "error"],
    ["timeout", "timeout", "timed_out"],
    ["output_limit", "output_limit", "error"],
    ["nonaccepted_exit", "nonaccepted_exit", "failed"],
    ["output_missing", "output_missing", "succeeded"],
    ["normalization", "normalization", "succeeded"],
  ] as const)("keeps %s failures private and cannot mint public semantics", async (
    behavior,
    expectedClass,
    expectedOutcome,
  ) => {
    const root = await mkdtemp(path.join(tmpdir(), `evleda-portable-kicad-${behavior}-`));
    roots.push(root);
    const fixture = await createOperation(root, "kicad_erc", Buffer.from("source\n"));
    const runner: BoundedProcessRunner = async (options) => {
      if (behavior === "spawn") throw new BoundedProcessError("spawn failed", options, "", "");
      if (behavior === "timeout") throw new ProcessTimeoutError("timed out", options, "partial", "");
      if (behavior === "output_limit") throw new ProcessOutputLimitError("output limit", options, "partial", "");
      if (behavior === "nonaccepted_exit") return successfulResult(options, 2);
      if (behavior === "normalization") await writeFile(options.args.at(-2)!, Buffer.from("not-json"));
      return successfulResult(options);
    };
    const request = buildKicadBackendRequestV3({
      stage: STAGE,
      expectedSourceRevisionDigest: SOURCE_REVISION,
      operations: [fixture.operation],
    });
    const execution = await new PortableKicadProducerV3({ runner, now: () => COMPLETED_AT }).execute({
      publicRequest: request,
      normalizer: normalizerTool,
      operations: [fixture.operation],
    });
    expect(execution.publicResult.operations[0]).toMatchObject({
      status: "private_runtime_rejected",
      semantics: null,
      rawBoundReceipt: null,
      hostAuthenticated: false,
      manufactureReady: false,
      releaseAuthorized: false,
    });
    const draft = execution.privateDrafts[0]!;
    expect(draft.disposition).toBe("detached-private-rejection-draft");
    if (draft.disposition !== "detached-private-rejection-draft") throw new Error("unexpected draft");
    expect(draft.rejection.failureClass).toBe(expectedClass);
    expect(draft.terminalInvocation.outcome).toBe(expectedOutcome);
    expect(JSON.stringify(execution.publicResult)).not.toContain("failureClass");
  });

  it("rejects a non-Rev-A D356 snapshot before invoking KiCad", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-portable-kicad-d356-scope-"));
    roots.push(root);
    const fixture = await createOperation(root, "kicad_d356", Buffer.from("not the reviewed board\n"));
    const runner = vi.fn<BoundedProcessRunner>(async (options) => successfulResult(options));
    const request = buildKicadBackendRequestV3({
      stage: STAGE,
      expectedSourceRevisionDigest: SOURCE_REVISION,
      operations: [fixture.operation],
    });
    await expect(new PortableKicadProducerV3({ runner, now: () => COMPLETED_AT }).execute({
      publicRequest: request,
      normalizer: normalizerTool,
      operations: [fixture.operation],
    })).rejects.toThrow(/exact reviewed Rev-A board/iu);
    expect(runner).not.toHaveBeenCalled();
  });

  it("enforces the operation-specific expected-output ceiling from process-plan v2", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-portable-kicad-output-cap-"));
    roots.push(root);
    const fixture = await createOperation(root, "kicad_stats", Buffer.from("source\n"));
    const ceiling = fixture.operation.nativeProcessPlan.expectedOutputs[0]!.maxBytes;
    expect(ceiling).toBe(2_097_152);
    const runner: BoundedProcessRunner = async (options) => {
      await writeFile(options.args.at(-2)!, Buffer.alloc(ceiling + 1, 0x20));
      return successfulResult(options);
    };
    const request = buildKicadBackendRequestV3({
      stage: STAGE,
      expectedSourceRevisionDigest: SOURCE_REVISION,
      operations: [fixture.operation],
    });
    const execution = await new PortableKicadProducerV3({ runner, now: () => COMPLETED_AT }).execute({
      publicRequest: request,
      normalizer: normalizerTool,
      operations: [fixture.operation],
    });
    expect(execution.publicResult.operations[0]).toMatchObject({
      status: "private_runtime_rejected",
      semantics: null,
      rawBoundReceipt: null,
    });
    const draft = execution.privateDrafts[0]!;
    expect(draft.disposition).toBe("detached-private-rejection-draft");
    if (draft.disposition === "detached-private-rejection-draft") {
      expect(draft.rejection).toMatchObject({
        failureClass: "output_limit",
        processOutcome: "succeeded",
        exitCode: 0,
        rawContentIdentity: null,
      });
    }
  });
});

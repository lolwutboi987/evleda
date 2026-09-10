import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalPortableJson,
  portableContentIdentity,
  type PortablePathRefV1,
} from "../../src/core/portable-artifact.js";
import {
  acceptedExitCodesForNativeProcessProfile,
  buildNativeProcessPlanV2,
  createApprovedNativeProcessContractRegistryV2,
  validateNativeProcessPlanV2,
} from "../../src/domain/native-process-plan.js";
import {
  PORTABLE_KICAD_ENVIRONMENT_POLICY_V1,
  APPROVED_PORTABLE_KICAD_RUNTIME_CONTRACT_VALIDATOR_V2,
  PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1,
  PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
  PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1,
  REVIEWED_KICAD_D356_REV_A_PROFILE_V1,
  assertApprovedPortableKicadNativeProcessPlanV2,
  buildKicadCapabilityByteEvidenceV1,
  buildKicadNativeToolIdentityV1,
  buildPortableKicadCommandPlanV1,
  buildPortableKicadNativeContractV2,
  buildPortableKicadNativeProcessPlanV2,
  buildPortableKicadNormalizerContractV2,
  buildPortableKicadNormalizerToolIdentityV1,
  buildPortableKicadSourceIdentitySetV1,
  resolvePortableKicadCommandPlanV2,
  type PortableKicadCommandKindV1,
} from "../../src/integrations/portable-kicad-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const pathRef = (
  root: PortablePathRefV1["root"],
  relativePath: string,
): PortablePathRefV1 => ({
  schemaVersion: "evleda.portable-path-ref.v1",
  root,
  relativePath,
});

const executableBytes = Buffer.from("bounded fake kicad executable\n", "utf8");
const helpBytes = Buffer.from("exact captured KiCad help\n", "utf8");
const capabilityBytes = Buffer.from('{"exact":"capabilities"}', "utf8");

const nativeTool = () =>
  buildKicadNativeToolIdentityV1({
    version: "10.0.3",
    commit: "1".repeat(40),
    executableContentIdentity: portableContentIdentity(executableBytes),
    helpCaptureBytes: helpBytes,
    capabilityManifestBytes: capabilityBytes,
  });

const normalizerTool = () =>
  buildPortableKicadNormalizerToolIdentityV1({
    name: "evleda-kicad-normalizer",
    version: "2.0.0",
    commit: "2".repeat(40),
    implementationBytes: Buffer.from("normalizer implementation", "utf8"),
    capabilityBytes: Buffer.from("normalizer capabilities", "utf8"),
    helpBytes: Buffer.from("normalizer contract", "utf8"),
  });

const matrixPaths: Readonly<
  Record<PortableKicadCommandKindV1, { readonly source: string; readonly output: string }>
> = {
  kicad_erc: { source: "snapshots/kicad_erc/controller.kicad_sch", output: "captures/kicad_erc/controller.erc.json" },
  kicad_drc: { source: "snapshots/kicad_drc/controller.kicad_pcb", output: "captures/kicad_drc/controller.drc.json" },
  kicad_netlist: {
    source: "snapshots/kicad_netlist/controller.kicad_sch",
    output: "captures/kicad_netlist/controller.kicad_net",
  },
  kicad_stats: {
    source: "snapshots/kicad_stats/controller.kicad_pcb",
    output: "captures/kicad_stats/controller.stats.json",
  },
  kicad_d356: { source: "snapshots/kicad_d356/controller.kicad_pcb", output: "captures/kicad_d356/controller.d356" },
  kicad_pdf: { source: "snapshots/kicad_pdf/controller.kicad_sch", output: "captures/kicad_pdf/controller.pdf" },
};

// Independent copy of the Phase-1 V2/PDF validator signatures. This prevents a
// planner/matrix edit from making the test pass by changing both sides together.
const frozenPhase1Signatures: Readonly<Record<PortableKicadCommandKindV1, readonly string[]>> = {
  kicad_erc: ["sch", "erc", "--format", "json", "--units", "mm", "--severity-all", "--exit-code-violations", "--output", "<output>", "<source>"],
  kicad_drc: ["pcb", "drc", "--schematic-parity", "--refill-zones", "--save-board", "--format", "json", "--units", "mm", "--severity-all", "--exit-code-violations", "--output", "<output>", "<source>"],
  kicad_netlist: ["sch", "export", "netlist", "--output", "<output>", "<source>"],
  kicad_stats: ["pcb", "export", "stats", "--format", "json", "--output", "<output>", "<source>"],
  kicad_d356: ["pcb", "export", "ipcd356", "--output", "<output>", "<source>"],
  kicad_pdf: ["sch", "export", "pdf", "--output", "<output>", "<source>"],
};

const buildPlan = (kind: PortableKicadCommandKindV1) =>
  buildPortableKicadCommandPlanV1({
    commandKind: kind,
    tool: nativeTool(),
    logicalCwd: pathRef("run_input", path.posix.dirname(matrixPaths[kind].source)),
    sourcePath: pathRef("run_input", matrixPaths[kind].source),
    outputPath: pathRef("run_private", matrixPaths[kind].output),
    ...(kind === "kicad_d356" ? { d356Profile: REVIEWED_KICAD_D356_REV_A_PROFILE_V1 } : {}),
  });

const buildProcessPlan = (kind: PortableKicadCommandKindV1) =>
  buildPortableKicadNativeProcessPlanV2({
    commandKind: kind,
    commandPlan: buildPlan(kind),
    ...(kind === "kicad_d356" ? { d356Profile: REVIEWED_KICAD_D356_REV_A_PROFILE_V1 } : {}),
  });

describe("portable KiCad runtime command contract", () => {
  it("constructs the one exact frozen V2/PDF command matrix without host paths", () => {
    const approvedRegistry = createApprovedNativeProcessContractRegistryV2([
      APPROVED_PORTABLE_KICAD_RUNTIME_CONTRACT_VALIDATOR_V2,
    ]);
    for (const kind of Object.keys(matrixPaths) as PortableKicadCommandKindV1[]) {
      expect(PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[kind].argv).toEqual(
        frozenPhase1Signatures[kind],
      );
      const plan = buildPlan(kind);
      const signature = plan.argv.map((argument) =>
        argument.kind === "literal"
          ? argument.value
          : argument.value.root === "run_private"
            ? "<output>"
            : "<source>",
      );
      expect(signature).toEqual(PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[kind].argv);
      expect(plan.environment).toEqual(PORTABLE_KICAD_ENVIRONMENT_POLICY_V1);
      expect(plan.commandPlanIdentity.schemaVersion).toBe("evleda.typed-command-plan.v1");
      expect(canonicalPortableJson(plan)).not.toMatch(/[A-Za-z]:[\\/]/u);
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.argv)).toBe(true);
      const processPlan = buildPortableKicadNativeProcessPlanV2({
        commandKind: kind,
        commandPlan: plan,
        ...(kind === "kicad_d356"
          ? { d356Profile: REVIEWED_KICAD_D356_REV_A_PROFILE_V1 }
          : {}),
      });
      expect(processPlan.transport).toBe("native_process");
      expect(processPlan.profile.contractIdentity).toEqual(
        PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
      );
      expect(processPlan.command).toEqual({
        kind: "portable_typed_command_v1",
        value: plan,
      });
      expect(processPlan.acceptedExitCodes).toEqual(
        PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands[kind].acceptedExitCodes,
      );
      expect(processPlan.planIdentity.schemaVersion).toBe("evleda.native-process-plan.v2");
      expect(processPlan.expectedOutputs).toEqual([
        {
          schemaVersion: "evleda.native-process-expected-output.v1",
          path: plan.expectedOutputs[0],
          maxBytes: PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1.limits[kind],
        },
      ]);
      expect(approvedRegistry.assertApproved(processPlan)).toEqual(processPlan);
    }
    expect(PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1.schemaVersion).toBe(
      "evleda.kicad-runtime-command-contract.v1",
    );
    expect(
      PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands.kicad_drc.sourceDisposition,
    ).toBe("isolated-writable-copy");
    expect(PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_V1.commands.kicad_pdf.publicSemantics).toBe(
      "private-non-semantic",
    );
  });

  it("binds exact operation-specific output ceilings and rejects every boundary mismatch", () => {
    const statsPlan = buildProcessPlan("kicad_stats");
    const { planIdentity: _identity, ...statsDraft } = statsPlan;
    const wrongButNeutrallyValid = buildNativeProcessPlanV2({
      ...statsDraft,
      expectedOutputs: statsPlan.expectedOutputs.map((descriptor) => ({
        ...descriptor,
        maxBytes: PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1.limits.kicad_stats + 1,
      })),
    });
    expect(validateNativeProcessPlanV2(wrongButNeutrallyValid)).toEqual(
      wrongButNeutrallyValid,
    );
    expect(() =>
      assertApprovedPortableKicadNativeProcessPlanV2(wrongButNeutrallyValid),
    ).toThrow(/byte ceiling/iu);

    expect(() =>
      buildNativeProcessPlanV2({
        ...statsDraft,
        expectedOutputs: statsPlan.expectedOutputs.map((descriptor) => ({
          ...descriptor,
          maxBytes: 0,
        })),
      }),
    ).toThrow(/greater than or equal to 1|invalid/iu);

    expect(() =>
      buildNativeProcessPlanV2({
        ...statsDraft,
        expectedOutputs: statsPlan.expectedOutputs.map((descriptor) => ({
          ...descriptor,
          path: pathRef("run_private", "captures/kicad_stats/attacker.stats.json"),
        })),
      }),
    ).toThrow(/one-to-one in exact order/iu);
  });

  it("rejects a neutrally valid plan whose self-labelled operation disagrees with argv", () => {
    const netlistPlan = buildProcessPlan("kicad_netlist");
    const { planIdentity: _identity, ...netlistDraft } = netlistPlan;
    const dishonestProfile = {
      schemaVersion: "evleda.native-process-profile.kicad.v1" as const,
      domain: "kicad" as const,
      operation: "kicad_erc" as const,
      contractIdentity: PORTABLE_KICAD_RUNTIME_COMMAND_CONTRACT_IDENTITY_V1,
    };
    const structurallyValid = buildNativeProcessPlanV2({
      ...netlistDraft,
      profile: dishonestProfile,
      acceptedExitCodes: acceptedExitCodesForNativeProcessProfile(dishonestProfile),
    });
    expect(validateNativeProcessPlanV2(structurallyValid)).toEqual(structurallyValid);
    expect(() =>
      assertApprovedPortableKicadNativeProcessPlanV2(structurallyValid),
    ).toThrow(/versioned runtime command contract/iu);
    const approvedRegistry = createApprovedNativeProcessContractRegistryV2([
      APPROVED_PORTABLE_KICAD_RUNTIME_CONTRACT_VALIDATOR_V2,
    ]);
    expect(() => approvedRegistry.assertApproved(structurallyValid)).toThrow(
      /versioned runtime command contract/iu,
    );
  });

  it("rejects D356 without the reviewed profile and pins V2 to the exact Rev-A PCB bytes", async () => {
    expect(() =>
      buildPortableKicadCommandPlanV1({
        commandKind: "kicad_d356",
        tool: nativeTool(),
        logicalCwd: pathRef("run_input", "snapshots/kicad_d356"),
        sourcePath: pathRef("run_input", "snapshots/kicad_d356/controller.kicad_pcb"),
        outputPath: pathRef("run_private", "captures/kicad_d356/controller.d356"),
      }),
    ).toThrow(/reviewed Rev-A profile/iu);

    const boardBytes = await readFile(
      path.resolve(
        "reference-designs",
        "robotics-controller-v0",
        "robotics-controller-v0.kicad_pcb",
      ),
    );
    const sourceSet = buildPortableKicadSourceIdentitySetV1({
      commandKind: "kicad_d356",
      sourcePath: pathRef("run_input", "snapshots/kicad_d356/controller.kicad_pcb"),
      sourceBytes: boardBytes,
      d356Profile: REVIEWED_KICAD_D356_REV_A_PROFILE_V1,
    });
    expect(sourceSet.sourceBinding.sourceArtifactIdentity).toEqual(
      REVIEWED_KICAD_D356_REV_A_PROFILE_V1.exactBoardContentIdentity,
    );
    expect(Object.isFrozen(sourceSet.sourceContractPreimage)).toBe(true);
    expect(Object.isFrozen(sourceSet.sourceRevisionPreimage)).toBe(true);

    const changed = Buffer.from(boardBytes);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(() =>
      buildPortableKicadSourceIdentitySetV1({
        commandKind: "kicad_d356",
        sourcePath: pathRef("run_input", "snapshots/kicad_d356/controller.kicad_pcb"),
        sourceBytes: changed,
        d356Profile: REVIEWED_KICAD_D356_REV_A_PROFILE_V1,
      }),
    ).toThrow(/exact reviewed Rev-A PCB bytes/iu);
  });

  it("builds immutable byte-bound tool, source, native, and normalizer identities", () => {
    const observedStdout = Buffer.from("Usage --help --output\n", "utf8");
    const evidence = buildKicadCapabilityByteEvidenceV1({
      version: "10.0.3",
      commit: "3".repeat(40),
      probes: [
        {
          argv: ["sch", "erc", "--help"],
          requiredTokens: ["--output"],
          stdoutBytes: observedStdout,
          stderrBytes: Buffer.alloc(0),
        },
      ],
    });
    const capturedHelpDigest = evidence.helpIdentity.digest;
    const capturedHelpBytes = Buffer.from(evidence.helpCaptureBytes);
    const capturedCapabilityBytes = Buffer.from(evidence.capabilityManifestBytes);
    observedStdout.fill(0);
    expect(evidence.helpIdentity.digest).toBe(capturedHelpDigest);
    const hostileHelpView = evidence.helpCaptureBytes;
    const hostileCapabilityView = evidence.capabilityManifestBytes;
    hostileHelpView.fill(0);
    hostileCapabilityView.fill(0);
    expect(evidence.helpCaptureBytes).toEqual(capturedHelpBytes);
    expect(evidence.capabilityManifestBytes).toEqual(capturedCapabilityBytes);
    expect(evidence.helpCaptureBytes).not.toBe(evidence.helpCaptureBytes);
    expect(evidence.capabilityManifestBytes).not.toBe(evidence.capabilityManifestBytes);
    expect(portableContentIdentity(evidence.helpCaptureBytes)).toEqual(evidence.helpIdentity);
    expect(portableContentIdentity(evidence.capabilityManifestBytes)).toEqual(
      evidence.capabilitiesIdentity,
    );
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.helpIdentity)).toBe(true);

    const tool = buildKicadNativeToolIdentityV1({
      version: "10.0.3",
      commit: "3".repeat(40),
      executableContentIdentity: portableContentIdentity(executableBytes),
      helpCaptureBytes: evidence.helpCaptureBytes,
      capabilityManifestBytes: evidence.capabilityManifestBytes,
    });
    expect(tool.helpIdentity).toEqual(evidence.helpIdentity);
    expect(tool.capabilitiesIdentity).toEqual(evidence.capabilitiesIdentity);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool.contentIdentity)).toBe(true);

    const sourceSet = buildPortableKicadSourceIdentitySetV1({
      commandKind: "kicad_netlist",
      sourcePath: pathRef("run_input", "snapshots/kicad_netlist/controller.kicad_sch"),
      sourceBytes: Buffer.from("(kicad_sch)\n", "utf8"),
    });
    const plan = buildPortableKicadCommandPlanV1({
      commandKind: "kicad_netlist",
      tool,
      logicalCwd: pathRef("run_input", "snapshots/kicad_netlist"),
      sourcePath: sourceSet.sourceBinding.sourcePath,
      outputPath: pathRef("run_private", "captures/kicad_netlist/controller.kicad_net"),
    });
    const nativeContract = buildPortableKicadNativeContractV2({
      commandKind: "kicad_netlist",
      nativeProcessPlan: buildPortableKicadNativeProcessPlanV2({
        commandKind: "kicad_netlist",
        commandPlan: plan,
      }),
      sourceIdentitySet: sourceSet,
      invocationInputSourceIdentity: sourceSet.sourceBinding.sourceArtifactIdentity,
    });
    const normalizerContract = buildPortableKicadNormalizerContractV2({
      commandKind: "kicad_netlist",
      normalizer: normalizerTool(),
    });
    expect(nativeContract.identity.schemaVersion).toBe("evleda.native-validation-contract.v1");
    expect(nativeContract.preimage.nativeProcessPlanIdentity.schemaVersion).toBe(
      "evleda.native-process-plan.v2",
    );
    expect(nativeContract.preimage.expectedOutputs[0]?.maxBytes).toBe(16_777_216);
    expect(normalizerContract.preimage.maxOutputBytes).toBe(16_777_216);
    expect(nativeContract.preimage.acceptedExitCodes).toEqual([0]);
    expect(normalizerContract.identity.schemaVersion).toBe(
      "evleda.portable-normalizer-contract.v1",
    );
    expect(Object.isFrozen(nativeContract.preimage)).toBe(true);
    expect(Object.isFrozen(normalizerContract.preimage)).toBe(true);
    expect(nativeContract.preimage.authority).toBe("integrity-only");
    expect(nativeContract.preimage.releaseAuthorized).toBe(false);
  });

  it("segregates a DRC-saved source from D356/stats and binds the exact evaluated bytes", async () => {
    const originalBoardBytes = await readFile(
      path.resolve(
        "reference-designs",
        "robotics-controller-v0",
        "robotics-controller-v0.kicad_pcb",
      ),
    );
    const invocationInputIdentity = portableContentIdentity(originalBoardBytes);
    const drcEvaluatedBytes = Buffer.concat([
      originalBoardBytes,
      Buffer.from("; isolated post-refill/save mutation\n", "utf8"),
    ]);
    const drcSource = buildPortableKicadSourceIdentitySetV1({
      commandKind: "kicad_drc",
      sourcePath: pathRef("run_input", "snapshots/kicad_drc/controller.kicad_pcb"),
      sourceBytes: drcEvaluatedBytes,
    });
    const drcPlan = buildPortableKicadCommandPlanV1({
      commandKind: "kicad_drc",
      tool: nativeTool(),
      logicalCwd: pathRef("run_input", "snapshots/kicad_drc"),
      sourcePath: drcSource.sourceBinding.sourcePath,
      outputPath: pathRef("run_private", "captures/kicad_drc/controller.drc.json"),
    });
    const drcContract = buildPortableKicadNativeContractV2({
      commandKind: "kicad_drc",
      nativeProcessPlan: buildPortableKicadNativeProcessPlanV2({
        commandKind: "kicad_drc",
        commandPlan: drcPlan,
      }),
      sourceIdentitySet: drcSource,
      invocationInputSourceIdentity: invocationInputIdentity,
    });
    expect(drcContract.preimage.sourceSnapshotPolicy).toBe("one-command-one-copy");
    expect(drcContract.preimage.sourceEvaluationCapture).toBe("post-refill-and-save");
    expect(drcContract.preimage.invocationInputSourceIdentity).toEqual(invocationInputIdentity);
    expect(drcContract.preimage.evaluatedSourceIdentity).toEqual(
      portableContentIdentity(drcEvaluatedBytes),
    );
    expect(drcContract.preimage.evaluatedSourceIdentity).not.toEqual(invocationInputIdentity);

    const d356Source = buildPortableKicadSourceIdentitySetV1({
      commandKind: "kicad_d356",
      sourcePath: pathRef("run_input", "snapshots/kicad_d356/controller.kicad_pcb"),
      sourceBytes: originalBoardBytes,
      d356Profile: REVIEWED_KICAD_D356_REV_A_PROFILE_V1,
    });
    const statsSource = buildPortableKicadSourceIdentitySetV1({
      commandKind: "kicad_stats",
      sourcePath: pathRef("run_input", "snapshots/kicad_stats/controller.kicad_pcb"),
      sourceBytes: originalBoardBytes,
    });
    expect(d356Source.sourceBinding.sourceArtifactIdentity).toEqual(
      statsSource.sourceBinding.sourceArtifactIdentity,
    );
    expect(d356Source.sourceBinding.sourceContractIdentity).not.toEqual(
      statsSource.sourceBinding.sourceContractIdentity,
    );
    expect(d356Source.sourceBinding.sourceRevisionIdentity).not.toEqual(
      statsSource.sourceBinding.sourceRevisionIdentity,
    );
    expect(() =>
      buildPortableKicadCommandPlanV1({
        commandKind: "kicad_stats",
        tool: nativeTool(),
        logicalCwd: pathRef("run_input", "snapshots/kicad_drc"),
        sourcePath: pathRef("run_input", "snapshots/kicad_drc/controller.kicad_pcb"),
        outputPath: pathRef("run_private", "captures/kicad_stats/controller.stats.json"),
      }),
    ).toThrow(/fixed root and extension matrix/iu);
    expect(() =>
      buildPortableKicadSourceIdentitySetV1({
        commandKind: "kicad_d356",
        sourcePath: pathRef("run_input", "snapshots/kicad_d356/controller.kicad_pcb"),
        sourceBytes: drcEvaluatedBytes,
        d356Profile: REVIEWED_KICAD_D356_REV_A_PROFILE_V1,
      }),
    ).toThrow(/exact reviewed Rev-A PCB bytes/iu);
  });
});

describe("private confined KiCad command resolution", () => {
  it("hash-checks runtime evidence and resolves logical paths only inside disjoint roots", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "evleda-portable-runtime-"));
    temporaryRoots.push(workspace);
    const reference = path.join(workspace, "reference");
    const runInput = path.join(workspace, "run-input");
    const design = path.join(runInput, "snapshots", "kicad_stats");
    const runPrivate = path.join(workspace, "run-private");
    const captures = path.join(runPrivate, "captures", "kicad_stats");
    const privateDirectories = ["home", "kicad-config", "temp", "tmp"];
    await Promise.all([
      mkdir(reference),
      mkdir(design, { recursive: true }),
      mkdir(captures, { recursive: true }),
      ...privateDirectories.map(async (directory) =>
        await mkdir(path.join(runPrivate, directory), { recursive: true }),
      ),
    ]);
    const sourcePath = path.join(design, "controller.kicad_pcb");
    const executablePath = path.join(workspace, "kicad-cli.exe");
    await Promise.all([
      writeFile(sourcePath, "(kicad_pcb)\n", "utf8"),
      writeFile(executablePath, executableBytes),
    ]);
    const invocationInputSourceIdentity = portableContentIdentity("(kicad_pcb)\n");
    const privateEnvironmentPaths = {
      HOME: pathRef("run_private", "home"),
      KICAD_CONFIG_HOME: pathRef("run_private", "kicad-config"),
      TEMP: pathRef("run_private", "temp"),
      TMP: pathRef("run_private", "tmp"),
    } as const;
    const resolved = await resolvePortableKicadCommandPlanV2({
      commandKind: "kicad_stats",
      nativeProcessPlan: buildProcessPlan("kicad_stats"),
      roots: { reference, runInput, runPrivate },
      executablePath,
      invocationInputSourceIdentity,
      helpCaptureBytes: helpBytes,
      capabilityManifestBytes: capabilityBytes,
      privateEnvironmentPaths,
    });
    expect(resolved.disposition).toBe("private-runtime-only");
    expect(resolved.command).toBe(await path.resolve(executablePath));
    expect(resolved.cwd).toBe(await path.resolve(design));
    expect(resolved.argv.at(-1)).toBe(await path.resolve(sourcePath));
    expect(resolved.argv.at(-2)).toBe(path.resolve(captures, "controller.stats.json"));
    expect(resolved.expectedOutputPaths).toEqual([
      path.resolve(captures, "controller.stats.json"),
    ]);
    expect(resolved.expectedOutputs).toEqual([
      {
        path: path.resolve(captures, "controller.stats.json"),
        maxBytes: 2_097_152,
      },
    ]);
    expect(Object.isFrozen(resolved.expectedOutputs)).toBe(true);
    expect(Object.isFrozen(resolved.expectedOutputs[0])).toBe(true);
    expect(resolved.environment.KICAD_CONFIG_HOME).toBe(
      path.resolve(runPrivate, "kicad-config"),
    );
    expect(resolved.environment.LC_ALL).toBe("C");
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.argv)).toBe(true);
    expect(Object.isFrozen(resolved.environment)).toBe(true);
    const serializedResolution = JSON.stringify(resolved);
    expect(serializedResolution).not.toContain(workspace);
    expect(serializedResolution).not.toContain("environment");
    expect(serializedResolution).not.toContain("argv");

    await expect(
      resolvePortableKicadCommandPlanV2({
        commandKind: "kicad_stats",
        nativeProcessPlan: buildProcessPlan("kicad_stats"),
        roots: { reference, runInput, runPrivate },
        executablePath,
        invocationInputSourceIdentity: portableContentIdentity("different source"),
        helpCaptureBytes: helpBytes,
        capabilityManifestBytes: capabilityBytes,
        privateEnvironmentPaths,
      }),
    ).rejects.toThrow(/source bytes do not match/iu);

    await expect(
      resolvePortableKicadCommandPlanV2({
        commandKind: "kicad_stats",
        nativeProcessPlan: buildProcessPlan("kicad_stats"),
        roots: { reference, runInput, runPrivate },
        executablePath,
        invocationInputSourceIdentity,
        helpCaptureBytes: Buffer.from("different help", "utf8"),
        capabilityManifestBytes: capabilityBytes,
        privateEnvironmentPaths,
      }),
    ).rejects.toThrow(/do not match the pinned tool identity/iu);

    await writeFile(executablePath, "changed executable", "utf8");
    await expect(
      resolvePortableKicadCommandPlanV2({
        commandKind: "kicad_stats",
        nativeProcessPlan: buildProcessPlan("kicad_stats"),
        roots: { reference, runInput, runPrivate },
        executablePath,
        invocationInputSourceIdentity,
        helpCaptureBytes: helpBytes,
        capabilityManifestBytes: capabilityBytes,
        privateEnvironmentPaths,
      }),
    ).rejects.toThrow(/do not match the pinned tool identity/iu);
  });

  it("rejects overlapping roots before exposing an executable argv", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "evleda-portable-overlap-"));
    temporaryRoots.push(workspace);
    const runInput = path.join(workspace, "run-input");
    const design = path.join(runInput, "snapshots", "kicad_stats");
    const runPrivate = path.join(workspace, "run-private");
    await Promise.all([
      mkdir(design, { recursive: true }),
      mkdir(path.join(runPrivate, "captures", "kicad_stats"), { recursive: true }),
      ...["home", "kicad-config", "temp", "tmp"].map(async (directory) =>
        await mkdir(path.join(runPrivate, directory), { recursive: true }),
      ),
    ]);
    const executablePath = path.join(workspace, "kicad-cli.exe");
    await Promise.all([
      writeFile(path.join(design, "controller.kicad_pcb"), "(kicad_pcb)\n", "utf8"),
      writeFile(executablePath, executableBytes),
    ]);
    await expect(
      resolvePortableKicadCommandPlanV2({
        commandKind: "kicad_stats",
        nativeProcessPlan: buildProcessPlan("kicad_stats"),
        roots: { reference: runInput, runInput, runPrivate },
        executablePath,
        invocationInputSourceIdentity: portableContentIdentity("(kicad_pcb)\n"),
        helpCaptureBytes: helpBytes,
        capabilityManifestBytes: capabilityBytes,
        privateEnvironmentPaths: {
          HOME: pathRef("run_private", "home"),
          KICAD_CONFIG_HOME: pathRef("run_private", "kicad-config"),
          TEMP: pathRef("run_private", "temp"),
          TMP: pathRef("run_private", "tmp"),
        },
      }),
    ).rejects.toThrow(/must not overlap/iu);
  });
});

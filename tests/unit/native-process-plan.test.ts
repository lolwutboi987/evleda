import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import {
  NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION,
  NATIVE_PROCESS_MAX_EXPECTED_OUTPUT_BYTES,
  NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION,
  acceptedExitCodesForNativeProcessProfile,
  buildNativeProcessPlanV2,
  createApprovedNativeProcessContractRegistryV2,
  nativeProcessPlanV2Schema,
  validateNativeProcessPlanV2
} from "../../src/domain/native-process-plan.js";
import type {
  CanonicalIdentity,
  NativeProcessLogicalCommandV1,
  NativeProcessPlanV2,
  NativeProcessProfileV1,
  NativeProcessToolV1
} from "../../src/domain/types.js";

const identity = (schemaVersion: string, marker: string): CanonicalIdentity => ({
  algorithm: "sha256",
  digest: marker.repeat(64),
  schemaVersion,
  canonicalizationVersion: "evleda-c14n-json-v1"
});

const tool = (): NativeProcessToolV1 => ({
  schemaVersion: "evleda.tool-content-identity.v1",
  role: "runtime",
  kind: "native_executable",
  name: "arm-none-eabi-gcc",
  version: "14.2.1",
  commit: "1".repeat(40),
  contentIdentity: contentIdentity("compiler"),
  capabilitiesIdentity: contentIdentity("compiler capabilities"),
  helpIdentity: contentIdentity("compiler help")
});

const pathRef = (root: "run_input" | "run_private", relativePath: string) => ({
  schemaVersion: "evleda.portable-path-ref.v1" as const,
  root,
  relativePath
});

const command = (): NativeProcessLogicalCommandV1 => {
  const executable = tool();
  const output = pathRef("run_private", "firmware/output.o");
  const preimage = {
    schemaVersion: NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION,
    tool: executable,
    logicalCwd: pathRef("run_input", "firmware"),
    argv: [
      { kind: "literal" as const, value: "-mcpu=cortex-m0plus" },
      { kind: "literal" as const, value: "-c" },
      { kind: "path" as const, value: pathRef("run_input", "firmware/main.c") },
      { kind: "literal" as const, value: "-o" },
      { kind: "path" as const, value: output }
    ],
    environment: {
      schemaVersion: "evleda.native-process-environment.v1" as const,
      inheritance: "none" as const,
      fixed: [{ name: "LC_ALL", value: "C" }],
      privateRuntime: [{ name: "TEMP", disposition: "excluded-private" as const }]
    },
    expectedOutputs: [output]
  };
  return {
    ...preimage,
    commandIdentity: canonicalIdentity(
      preimage,
      NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION
    ) as NativeProcessLogicalCommandV1["commandIdentity"]
  };
};

const profile = (
  operation: "compile" | "link" | "objcopy"
): Extract<NativeProcessProfileV1, { domain: "firmware" }> => ({
  schemaVersion: "evleda.native-process-profile.firmware.v1",
  domain: "firmware",
  operation,
  contractIdentity: identity("evleda.firmware-runtime-command-contract.v1", "2")
});

const plan = (operation: "compile" | "link" | "objcopy" = "compile"): NativeProcessPlanV2 => {
  const selectedProfile = profile(operation);
  const selectedCommand = command();
  return buildNativeProcessPlanV2({
    schemaVersion: NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION,
    transport: "native_process",
    profile: selectedProfile,
    tool: selectedCommand.tool,
    command: { kind: "native_process_logical_command_v1", value: selectedCommand },
    expectedOutputs: selectedCommand.expectedOutputs.map((path) => ({
      schemaVersion: "evleda.native-process-expected-output.v1" as const,
      path,
      maxBytes: operation === "objcopy" ? 512 * 1024 : operation === "compile"
        ? 4 * 1024 * 1024
        : 16 * 1024 * 1024
    })),
    acceptedExitCodes: acceptedExitCodesForNativeProcessProfile(selectedProfile),
    timeoutMs: 120_000,
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: 512 * 1024,
    inputPolicy: {
      schemaVersion: "evleda.native-process-input-policy.v1",
      snapshot: "immutable_before_spawn",
      mutation: "immutable",
      evaluatedInput: "command_input"
    }
  });
};

describe("neutral native-process command plan", () => {
  it("represents firmware compile, link, and objcopy without a KiCad dependency", () => {
    for (const operation of ["compile", "link", "objcopy"] as const) {
      const value = plan(operation);
      expect(validateNativeProcessPlanV2(value)).toEqual(value);
      expect(value.profile).toMatchObject({ domain: "firmware", operation });
      expect(value.transport).toBe("native_process");
      expect(value.acceptedExitCodes).toEqual([0]);
      expect(value.planIdentity.schemaVersion).toBe(NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION);
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => createApprovedNativeProcessContractRegistryV2([]).assertApproved(plan("compile")))
      .toThrowError(/No approved operation-specific/iu);
  });

  it("recomputes inner and outer identities and rejects policy or tool substitution", () => {
    const valid = plan();
    const { planIdentity: _planIdentity, ...preimage } = valid;
    const changedLimit = buildNativeProcessPlanV2({
      ...preimage,
      expectedOutputs: [{
        ...preimage.expectedOutputs[0]!,
        maxBytes: preimage.expectedOutputs[0]!.maxBytes + 1
      }]
    });
    expect(changedLimit.planIdentity.digest).not.toBe(valid.planIdentity.digest);
    const hostileExitPreimage = { ...preimage, acceptedExitCodes: [0, 99] };
    const hostileExit = {
      ...hostileExitPreimage,
      planIdentity: canonicalIdentity(hostileExitPreimage, NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION)
    };
    expect(nativeProcessPlanV2Schema.safeParse(hostileExit).success).toBe(false);
    expect(nativeProcessPlanV2Schema.safeParse({
      ...valid,
      timeoutMs: valid.timeoutMs + 1
    }).success).toBe(false);
    for (const expectedOutputs of [
      [],
      [{ ...valid.expectedOutputs[0]!, maxBytes: 0 }],
      [{ ...valid.expectedOutputs[0]!, maxBytes: NATIVE_PROCESS_MAX_EXPECTED_OUTPUT_BYTES + 1 }],
      [{ ...valid.expectedOutputs[0]!, path: pathRef("run_private", "firmware/other.o") }],
      [valid.expectedOutputs[0]!, valid.expectedOutputs[0]!]
    ]) {
      expect(nativeProcessPlanV2Schema.safeParse({ ...valid, expectedOutputs }).success).toBe(false);
    }
    expect(nativeProcessPlanV2Schema.safeParse({
      ...valid,
      tool: { ...valid.tool, contentIdentity: contentIdentity("substituted") }
    }).success).toBe(false);
    expect(nativeProcessPlanV2Schema.safeParse({
      ...valid,
      profile: {
        ...valid.profile,
        contractIdentity: identity("evleda.kicad-runtime-command-contract.v1", "2")
      }
    }).success).toBe(false);
    expect(nativeProcessPlanV2Schema.safeParse({
      ...valid,
      command: {
        ...valid.command,
        value: {
          ...valid.command.value,
          argv: [{ kind: "literal", value: "-O2" }]
        }
      }
    }).success).toBe(false);
  });

  it("rejects non-process semantics, public outputs, embedded paths, and role crossing", () => {
    const valid = plan();
    expect(nativeProcessPlanV2Schema.safeParse({ ...valid, transport: "human_rpc" }).success)
      .toBe(false);
    expect(nativeProcessPlanV2Schema.safeParse({
      ...valid,
      tool: { ...valid.tool, role: "native_validator" },
      command: {
        ...valid.command,
        value: {
          ...valid.command.value,
          tool: { ...valid.command.value.tool, role: "native_validator" }
        }
      }
    }).success).toBe(false);
    expect(() => {
      const { planIdentity: _planIdentity, ...validDraft } = valid;
      const source = command();
      const output = pathRef("run_private", "firmware/output.o");
      const bad = {
        ...source,
        argv: [
          { kind: "literal" as const, value: "-Iprivate/path" },
          { kind: "path" as const, value: output }
        ]
      };
      const { commandIdentity: _identity, ...badPreimage } = bad;
      return buildNativeProcessPlanV2({
        ...validDraft,
        command: {
          kind: "native_process_logical_command_v1",
          value: {
            ...badPreimage,
            commandIdentity: canonicalIdentity(
              badPreimage,
              NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION
            ) as NativeProcessLogicalCommandV1["commandIdentity"]
          }
        }
      });
    }).toThrowError(/invalid/iu);

    expect(() => {
      const { planIdentity: _planIdentity, ...validDraft } = valid;
      const source = command();
      const publicOutput = {
        ...pathRef("run_private", "firmware/output.o"),
        root: "run_public" as const
      };
      const { commandIdentity: _identity, ...sourcePreimage } = source;
      const publicPreimage = {
        ...sourcePreimage,
        argv: [
          ...source.argv.slice(0, -1),
          { kind: "path" as const, value: publicOutput }
        ],
        expectedOutputs: [publicOutput]
      };
      return buildNativeProcessPlanV2({
        ...validDraft,
        command: {
          kind: "native_process_logical_command_v1",
          value: {
            ...publicPreimage,
            commandIdentity: canonicalIdentity(
              publicPreimage,
              NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION
            ) as NativeProcessLogicalCommandV1["commandIdentity"]
          }
        }
      });
    }).toThrowError(/private output/iu);
  });
});

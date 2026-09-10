import { z } from "zod";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { DomainError } from "./errors.js";
import type {
  CanonicalIdentity,
  NativeProcessCommandV1,
  NativeProcessExpectedOutputV1,
  NativeProcessLogicalCommandV1,
  NativeProcessPlanIdentity,
  NativeProcessPlanIdentityV2,
  NativeProcessPlanV1,
  NativeProcessPlanV2,
  NativeProcessPortableCommandV1,
  NativeProcessProfileV1,
  NativeProcessToolV1
} from "./types.js";

/** @deprecated Superseded before production because V1 omitted output byte ceilings. */
export const NATIVE_PROCESS_PLAN_SCHEMA_VERSION = "evleda.native-process-plan.v1" as const;
export const NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION = "evleda.native-process-plan.v2" as const;
export const NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION =
  "evleda.native-process-logical-command.v1" as const;
export const NATIVE_PROCESS_MAX_STREAM_BYTES = 1024 * 1024;
export const NATIVE_PROCESS_MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const NATIVE_PROCESS_MAX_EXPECTED_OUTPUT_BYTES = 16 * 1024 * 1024;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const schemaToken = z.string().regex(/^evleda\.[a-z0-9][a-z0-9._-]*\.v[1-9][0-9]*$/u);
const safeToken = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+@,=-]{0,127}$/u);
const commandLiteral = z.string().regex(
  /^(?:[A-Za-z0-9][A-Za-z0-9._+@,=-]{0,127}|--[a-z0-9][a-z0-9-]{0,125})$/u
);

const contentIdentitySchema = z.object({
  algorithm: z.literal("sha256"),
  digest: sha256,
  size: z.number().int().safe().nonnegative()
}).strict();

const canonicalIdentitySchema = z.object({
  algorithm: z.literal("sha256"),
  digest: sha256,
  schemaVersion: schemaToken,
  canonicalizationVersion: z.literal("evleda-c14n-json-v1")
}).strict();

const typedCommandPlanIdentitySchema = canonicalIdentitySchema.extend({
  schemaVersion: z.literal("evleda.typed-command-plan.v1")
}).strict();

const logicalCommandIdentitySchema = canonicalIdentitySchema.extend({
  schemaVersion: z.literal(NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION)
}).strict();

const planIdentitySchema = canonicalIdentitySchema.extend({
  schemaVersion: z.literal(NATIVE_PROCESS_PLAN_SCHEMA_VERSION)
}).strict();

const planIdentityV2Schema = canonicalIdentitySchema.extend({
  schemaVersion: z.literal(NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION)
}).strict();

const windowsDevice = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const pathRefSchema = z.object({
  schemaVersion: z.literal("evleda.portable-path-ref.v1"),
  root: z.enum(["reference", "run_input", "run_private", "run_public"]),
  relativePath: z.string().min(1).max(1024)
}).strict().superRefine((value, context) => {
  const segments = value.relativePath.split("/");
  if (
    !/^[\x20-\x7e]+$/u.test(value.relativePath) ||
    value.relativePath.startsWith("/") ||
    /[\\:?%#<>|"*]/u.test(value.relativePath) ||
    segments.length > 64 ||
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.length > 128 ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      windowsDevice.test(segment)
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["relativePath"],
      message: "Native-process paths must be bounded materializable relative POSIX paths"
    });
  }
});

const toolSchema = z.object({
  schemaVersion: z.literal("evleda.tool-content-identity.v1"),
  role: z.enum(["native_validator", "runtime"]),
  kind: z.literal("native_executable"),
  name: safeToken,
  version: safeToken,
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64}|not_applicable)$/u),
  contentIdentity: contentIdentitySchema,
  capabilitiesIdentity: contentIdentitySchema,
  helpIdentity: contentIdentitySchema
}).strict();

const portableArgumentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: commandLiteral }).strict(),
  z.object({ kind: z.literal("path"), value: pathRefSchema }).strict()
]);

const nativeLiteral = z.string().min(1).max(512).regex(/^[\x20-\x7e]+$/u).refine(
  (value) => !/[\\/]/u.test(value),
  { message: "Native-process literal arguments cannot embed path or URI syntax" }
);
const nativeArgumentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: nativeLiteral }).strict(),
  z.object({ kind: z.literal("path"), value: pathRefSchema }).strict()
]);

const portableEnvironmentSchema = z.object({
  schemaVersion: z.literal("evleda.portable-environment-policy.v1"),
  pythonHashSeed: z.literal("0"),
  pythonUtf8: z.literal("1"),
  locale: z.literal("C"),
  timezone: z.literal("UTC"),
  privateFields: z.array(z.object({
    name: z.enum(["HOME", "TEMP", "TMP", "KICAD_CONFIG_HOME"]),
    disposition: z.literal("excluded-private")
  }).strict()).length(4)
}).strict().superRefine((value, context) => {
  const expected = ["HOME", "KICAD_CONFIG_HOME", "TEMP", "TMP"];
  if (value.privateFields.some((entry, index) => entry.name !== expected[index])) {
    context.addIssue({
      code: "custom",
      path: ["privateFields"],
      message: "Portable private environment fields must be the exact sorted set"
    });
  }
});

const environmentName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/u);
const nativeEnvironmentSchema = z.object({
  schemaVersion: z.literal("evleda.native-process-environment.v1"),
  inheritance: z.literal("none"),
  fixed: z.array(z.object({
    name: environmentName,
    value: z.string().max(1024).regex(/^[\x20-\x7e]*$/u)
  }).strict()).max(64),
  privateRuntime: z.array(z.object({
    name: environmentName,
    disposition: z.literal("excluded-private")
  }).strict()).max(64)
}).strict().superRefine((value, context) => {
  const fixedNames = value.fixed.map((entry) => entry.name);
  const privateNames = value.privateRuntime.map((entry) => entry.name);
  const names = [...fixedNames, ...privateNames];
  const sortedFixedNames = [...fixedNames].sort();
  const sortedPrivateNames = [...privateNames].sort();
  if (
    new Set(names).size !== names.length ||
    fixedNames.some((name, index) => name !== sortedFixedNames[index]) ||
    privateNames.some((name, index) => name !== sortedPrivateNames[index])
  ) {
    context.addIssue({
      code: "custom",
      path: ["fixed"],
      message: "Environment fields must form one unique sorted sequence"
    });
  }
});

const commandCoreSchema = {
  tool: toolSchema,
  logicalCwd: pathRefSchema,
  expectedOutputs: z.array(pathRefSchema).min(1).max(32)
} as const;

const validateCommandPaths = (
  command: {
    readonly logicalCwd: { readonly root: string };
    readonly argv: readonly { readonly kind: string; readonly value: unknown }[];
    readonly expectedOutputs: readonly { readonly root: string; readonly relativePath: string }[];
  },
  context: z.RefinementCtx
): void => {
  if (command.logicalCwd.root !== "run_input" && command.logicalCwd.root !== "run_private") {
    context.addIssue({ code: "custom", path: ["logicalCwd"], message: "Native-process cwd must be run-local" });
  }
  const outputs = command.expectedOutputs.map((entry) => `${entry.root}/${entry.relativePath}`);
  if (
    outputs.some((output) => !output.startsWith("run_private/")) ||
    new Set(outputs).size !== outputs.length ||
    outputs.some((output) =>
      command.argv.filter((argument) =>
        argument.kind === "path" &&
        typeof argument.value === "object" &&
        argument.value !== null &&
        canonicalJson(argument.value) === canonicalJson(
          command.expectedOutputs[outputs.indexOf(output)]
        )
      ).length !== 1
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["expectedOutputs"],
      message: "Each unique private output must occur exactly once in structured argv"
    });
  }
};

const portableCommandSchema = z.object({
  schemaVersion: z.literal("evleda.typed-command-plan.v1"),
  ...commandCoreSchema,
  argv: z.array(portableArgumentSchema).min(1).max(256),
  environment: portableEnvironmentSchema,
  commandPlanIdentity: typedCommandPlanIdentitySchema
}).strict().superRefine((command, context) => {
  validateCommandPaths(command, context);
  const { commandPlanIdentity: _identity, ...preimage } = command;
  const expected = canonicalIdentity(preimage, "evleda.typed-command-plan.v1");
  if (canonicalJson(command.commandPlanIdentity) !== canonicalJson(expected)) {
    context.addIssue({
      code: "custom",
      path: ["commandPlanIdentity"],
      message: "Portable typed-command identity does not reproduce its stored preimage"
    });
  }
});

const logicalCommandSchema = z.object({
  schemaVersion: z.literal(NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION),
  ...commandCoreSchema,
  argv: z.array(nativeArgumentSchema).min(1).max(256),
  environment: nativeEnvironmentSchema,
  commandIdentity: logicalCommandIdentitySchema
}).strict().superRefine((command, context) => {
  validateCommandPaths(command, context);
  const { commandIdentity: _identity, ...preimage } = command;
  const expected = canonicalIdentity(preimage, NATIVE_PROCESS_LOGICAL_COMMAND_SCHEMA_VERSION);
  if (canonicalJson(command.commandIdentity) !== canonicalJson(expected)) {
    context.addIssue({
      code: "custom",
      path: ["commandIdentity"],
      message: "Logical-command identity does not reproduce its stored preimage"
    });
  }
});

const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("portable_typed_command_v1"), value: portableCommandSchema }).strict(),
  z.object({ kind: z.literal("native_process_logical_command_v1"), value: logicalCommandSchema }).strict()
]);

const kicadProfileSchema = z.object({
  schemaVersion: z.literal("evleda.native-process-profile.kicad.v1"),
  domain: z.literal("kicad"),
  operation: z.enum([
    "kicad_erc",
    "kicad_drc",
    "kicad_netlist",
    "kicad_stats",
    "kicad_d356",
    "kicad_pdf"
  ]),
  contractIdentity: canonicalIdentitySchema.extend({
    schemaVersion: z.literal("evleda.kicad-runtime-command-contract.v1")
  }).strict()
}).strict();

const firmwareProfileSchema = z.object({
  schemaVersion: z.literal("evleda.native-process-profile.firmware.v1"),
  domain: z.literal("firmware"),
  operation: z.enum(["compile", "link", "objcopy"]),
  contractIdentity: canonicalIdentitySchema.extend({
    schemaVersion: z.literal("evleda.firmware-runtime-command-contract.v1")
  }).strict()
}).strict();

const profileSchema = z.discriminatedUnion("domain", [kicadProfileSchema, firmwareProfileSchema]);

const inputPolicySchema = z.object({
  schemaVersion: z.literal("evleda.native-process-input-policy.v1"),
  snapshot: z.literal("immutable_before_spawn"),
  mutation: z.enum(["immutable", "isolated_copy"]),
  evaluatedInput: z.enum(["command_input", "post_execution_snapshot"])
}).strict();

export const acceptedExitCodesForNativeProcessProfile = (
  profile: NativeProcessProfileV1
): readonly number[] =>
  profile.domain === "kicad" && ["kicad_erc", "kicad_drc"].includes(profile.operation)
    ? Object.freeze([0, 5])
    : Object.freeze([0]);

const expectedInputPolicy = (profile: NativeProcessProfileV1) => ({
  schemaVersion: "evleda.native-process-input-policy.v1" as const,
  snapshot: "immutable_before_spawn" as const,
  mutation: profile.domain === "kicad" && profile.operation === "kicad_drc"
    ? "isolated_copy" as const
    : "immutable" as const,
  evaluatedInput: profile.domain === "kicad" && profile.operation === "kicad_drc"
    ? "post_execution_snapshot" as const
    : "command_input" as const
});

export const nativeProcessPlanSchema = z.object({
  schemaVersion: z.literal(NATIVE_PROCESS_PLAN_SCHEMA_VERSION),
  transport: z.literal("native_process"),
  profile: profileSchema,
  tool: toolSchema,
  command: commandSchema,
  acceptedExitCodes: z.array(z.number().int().safe().nonnegative().max(0xffff_ffff)).min(1).max(16),
  timeoutMs: z.number().int().positive().max(NATIVE_PROCESS_MAX_TIMEOUT_MS),
  maxStdoutBytes: z.number().int().positive().max(NATIVE_PROCESS_MAX_STREAM_BYTES),
  maxStderrBytes: z.number().int().positive().max(NATIVE_PROCESS_MAX_STREAM_BYTES),
  inputPolicy: inputPolicySchema,
  planIdentity: planIdentitySchema
}).strict().superRefine((plan, context) => {
  if (canonicalJson(plan.tool) !== canonicalJson(plan.command.value.tool)) {
    context.addIssue({
      code: "custom",
      path: ["tool"],
      message: "Native-process plan tool must equal the logical-command tool"
    });
  }
  if (
    (plan.profile.domain === "kicad" && plan.tool.role !== "native_validator") ||
    (plan.profile.domain === "firmware" && plan.tool.role !== "runtime")
  ) {
    context.addIssue({
      code: "custom",
      path: ["tool", "role"],
      message: "Native-process tool role does not match its domain profile"
    });
  }
  if (
    canonicalJson(plan.acceptedExitCodes) !==
      canonicalJson(acceptedExitCodesForNativeProcessProfile(plan.profile as NativeProcessProfileV1))
  ) {
    context.addIssue({
      code: "custom",
      path: ["acceptedExitCodes"],
      message: "Accepted exit codes do not match the closed native-process profile"
    });
  }
  if (
    canonicalJson(plan.inputPolicy) !==
      canonicalJson(expectedInputPolicy(plan.profile as NativeProcessProfileV1))
  ) {
    context.addIssue({
      code: "custom",
      path: ["inputPolicy"],
      message: "Input mutation and snapshot policy does not match the closed profile"
    });
  }
  const { planIdentity: _identity, ...preimage } = plan;
  const expected = canonicalIdentity(preimage, NATIVE_PROCESS_PLAN_SCHEMA_VERSION);
  if (canonicalJson(plan.planIdentity) !== canonicalJson(expected)) {
    context.addIssue({
      code: "custom",
      path: ["planIdentity"],
      message: "Native-process plan identity does not reproduce its stored preimage"
    });
  }
});

const expectedOutputV1Schema = z.object({
  schemaVersion: z.literal("evleda.native-process-expected-output.v1"),
  path: pathRefSchema,
  maxBytes: z.number().int().safe().positive().max(NATIVE_PROCESS_MAX_EXPECTED_OUTPUT_BYTES)
}).strict();

/**
 * Current pre-production plan. V1 is not accepted here: it lacked durable
 * per-output byte ceilings and was superseded before any production writer.
 */
export const nativeProcessPlanV2Schema = z.object({
  schemaVersion: z.literal(NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION),
  transport: z.literal("native_process"),
  profile: profileSchema,
  tool: toolSchema,
  command: commandSchema,
  expectedOutputs: z.array(expectedOutputV1Schema).min(1).max(32),
  acceptedExitCodes: z.array(z.number().int().safe().nonnegative().max(0xffff_ffff)).min(1).max(16),
  timeoutMs: z.number().int().positive().max(NATIVE_PROCESS_MAX_TIMEOUT_MS),
  maxStdoutBytes: z.number().int().positive().max(NATIVE_PROCESS_MAX_STREAM_BYTES),
  maxStderrBytes: z.number().int().positive().max(NATIVE_PROCESS_MAX_STREAM_BYTES),
  inputPolicy: inputPolicySchema,
  planIdentity: planIdentityV2Schema
}).strict().superRefine((plan, context) => {
  if (canonicalJson(plan.tool) !== canonicalJson(plan.command.value.tool)) {
    context.addIssue({
      code: "custom",
      path: ["tool"],
      message: "Native-process plan tool must equal the logical-command tool"
    });
  }
  if (
    (plan.profile.domain === "kicad" && plan.tool.role !== "native_validator") ||
    (plan.profile.domain === "firmware" && plan.tool.role !== "runtime")
  ) {
    context.addIssue({
      code: "custom",
      path: ["tool", "role"],
      message: "Native-process tool role does not match its domain profile"
    });
  }
  if (
    canonicalJson(plan.acceptedExitCodes) !==
      canonicalJson(acceptedExitCodesForNativeProcessProfile(plan.profile as NativeProcessProfileV1))
  ) {
    context.addIssue({
      code: "custom",
      path: ["acceptedExitCodes"],
      message: "Accepted exit codes do not match the closed native-process profile"
    });
  }
  if (
    canonicalJson(plan.inputPolicy) !==
      canonicalJson(expectedInputPolicy(plan.profile as NativeProcessProfileV1))
  ) {
    context.addIssue({
      code: "custom",
      path: ["inputPolicy"],
      message: "Input mutation and snapshot policy does not match the closed profile"
    });
  }

  const commandOutputs = plan.command.value.expectedOutputs;
  const descriptorKeys = plan.expectedOutputs.map((descriptor) => canonicalJson(descriptor.path));
  if (
    plan.expectedOutputs.length !== commandOutputs.length ||
    new Set(descriptorKeys).size !== descriptorKeys.length ||
    plan.expectedOutputs.some(
      (descriptor, index) => canonicalJson(descriptor.path) !== canonicalJson(commandOutputs[index])
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["expectedOutputs"],
      message: "Bounded outputs must match command expected outputs one-to-one in exact order"
    });
  }

  const { planIdentity: _identity, ...preimage } = plan;
  const expected = canonicalIdentity(preimage, NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION);
  if (canonicalJson(plan.planIdentity) !== canonicalJson(expected)) {
    context.addIssue({
      code: "custom",
      path: ["planIdentity"],
      message: "Native-process V2 plan identity does not reproduce its stored preimage"
    });
  }
});

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
};

export const validateNativeProcessPlanV1 = (value: unknown): NativeProcessPlanV1 => {
  const parsed = nativeProcessPlanSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message
      }));
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      `Native-process plan is invalid: ${issues[0]?.message ?? "unknown issue"}`,
      { issues }
    );
  }
  return deepFreeze(parsed.data as NativeProcessPlanV1);
};

export type NativeProcessPlanDraftV1 = Omit<NativeProcessPlanV1, "planIdentity">;

export const buildNativeProcessPlanV1 = (
  draft: NativeProcessPlanDraftV1
): NativeProcessPlanV1 => validateNativeProcessPlanV1({
  ...draft,
  planIdentity: canonicalIdentity(draft, NATIVE_PROCESS_PLAN_SCHEMA_VERSION)
});

export const nativeProcessPlanIdentityV1 = (
  plan: NativeProcessPlanV1
): NativeProcessPlanIdentity => validateNativeProcessPlanV1(plan).planIdentity;

export const validateNativeProcessPlanV2 = (value: unknown): NativeProcessPlanV2 => {
  const parsed = nativeProcessPlanV2Schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((issue) => ({
      path: issue.path,
      code: issue.code,
      message: issue.message
    }));
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      `Native-process V2 plan is invalid: ${issues[0]?.message ?? "unknown issue"}`,
      { issues }
    );
  }
  return deepFreeze(parsed.data as NativeProcessPlanV2);
};

export type NativeProcessPlanDraftV2 = Omit<NativeProcessPlanV2, "planIdentity">;

export const buildNativeProcessPlanV2 = (
  draft: NativeProcessPlanDraftV2
): NativeProcessPlanV2 => validateNativeProcessPlanV2({
  ...draft,
  planIdentity: canonicalIdentity(draft, NATIVE_PROCESS_PLAN_V2_SCHEMA_VERSION)
});

export const nativeProcessPlanIdentityV2 = (
  plan: NativeProcessPlanV2
): NativeProcessPlanIdentityV2 => validateNativeProcessPlanV2(plan).planIdentity;

/**
 * Deterministic compatibility projection for frozen Phase-1 receipt bindings.
 * V1 had no outer expected-output descriptors, so only that V2 field and the
 * versioned outer identity are removed; the complete logical command remains.
 */
export const projectNativeProcessPlanV2ToLegacyV1 = (
  plan: NativeProcessPlanV2
): NativeProcessPlanV1 => {
  const validated = validateNativeProcessPlanV2(plan);
  const {
    schemaVersion: _schemaVersion,
    expectedOutputs: _expectedOutputs,
    planIdentity: _planIdentity,
    ...shared
  } = validated;
  return buildNativeProcessPlanV1({
    ...shared,
    schemaVersion: NATIVE_PROCESS_PLAN_SCHEMA_VERSION
  });
};

export const commandIdentityForNativeProcessPlan = (
  command: NativeProcessCommandV1
): CanonicalIdentity => command.kind === "portable_typed_command_v1"
  ? (command.value as NativeProcessPortableCommandV1).commandPlanIdentity
  : (command.value as NativeProcessLogicalCommandV1).commandIdentity;

export const nativeProcessToolForPlan = (plan: NativeProcessPlanV1): NativeProcessToolV1 =>
  validateNativeProcessPlanV1(plan).tool;

export type NativeProcessProfileDomainV1 = NativeProcessProfileV1["domain"];
export type NativeProcessOperationV1 = NativeProcessProfileV1["operation"];

/** Trusted composition boundary for operation-specific command admission. */
export interface ApprovedNativeProcessContractValidator {
  readonly validatorId: string;
  readonly profileDomain: NativeProcessProfileDomainV1;
  readonly operations: readonly NativeProcessOperationV1[];
  readonly contractIdentity: CanonicalIdentity;
  assertApproved(plan: NativeProcessPlanV1): NativeProcessPlanV1;
}

export interface ApprovedNativeProcessContractRegistry {
  assertApproved(plan: NativeProcessPlanV1): NativeProcessPlanV1;
}

export const nativeProcessContractRegistryKey = (
  profile: NativeProcessProfileV1
): string => [
  profile.domain,
  profile.operation,
  profile.contractIdentity.schemaVersion,
  profile.contractIdentity.digest
].join("\u0000");

const allowedOperations = Object.freeze({
  kicad: new Set<NativeProcessOperationV1>([
    "kicad_erc",
    "kicad_drc",
    "kicad_netlist",
    "kicad_stats",
    "kicad_d356",
    "kicad_pdf"
  ]),
  firmware: new Set<NativeProcessOperationV1>(["compile", "link", "objcopy"])
});

export const createApprovedNativeProcessContractRegistry = (
  validators: readonly ApprovedNativeProcessContractValidator[]
): ApprovedNativeProcessContractRegistry => {
  const byKey = new Map<string, ApprovedNativeProcessContractValidator>();
  for (const validator of validators) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(validator.validatorId) ||
      !["kicad", "firmware"].includes(validator.profileDomain) ||
      validator.operations.length === 0 ||
      new Set(validator.operations).size !== validator.operations.length ||
      !canonicalIdentitySchema.safeParse(validator.contractIdentity).success ||
      typeof validator.assertApproved !== "function" ||
      (validator.profileDomain === "kicad"
        ? validator.contractIdentity.schemaVersion !== "evleda.kicad-runtime-command-contract.v1"
        : validator.contractIdentity.schemaVersion !== "evleda.firmware-runtime-command-contract.v1")
    ) {
      throw new DomainError("INVALID_ARGUMENT", "Approved native-process validator is malformed", {
        validatorId: validator.validatorId
      });
    }
    for (const operation of validator.operations) {
      if (!allowedOperations[validator.profileDomain].has(operation)) {
        throw new DomainError("INVALID_ARGUMENT", "Validator operation crosses its profile domain", {
          validatorId: validator.validatorId,
          profileDomain: validator.profileDomain,
          operation
        });
      }
      const profile = {
        schemaVersion: validator.profileDomain === "kicad"
          ? "evleda.native-process-profile.kicad.v1" as const
          : "evleda.native-process-profile.firmware.v1" as const,
        domain: validator.profileDomain,
        operation,
        contractIdentity: validator.contractIdentity
      } as NativeProcessProfileV1;
      const key = nativeProcessContractRegistryKey(profile);
      if (byKey.has(key)) {
        throw new DomainError("INVALID_ARGUMENT", "Duplicate approved native-process contract", {
          validatorId: validator.validatorId,
          profileDomain: validator.profileDomain,
          operation
        });
      }
      byKey.set(key, Object.freeze({
        validatorId: validator.validatorId,
        profileDomain: validator.profileDomain,
        operations: Object.freeze([...validator.operations]),
        contractIdentity: structuredClone(validator.contractIdentity),
        assertApproved: validator.assertApproved
      }));
    }
  }

  return Object.freeze({
    assertApproved(plan: NativeProcessPlanV1): NativeProcessPlanV1 {
      const validated = validateNativeProcessPlanV1(plan);
      const validator = byKey.get(nativeProcessContractRegistryKey(validated.profile));
      if (validator === undefined) {
        throw new DomainError(
          "CAPABILITY_REQUIRED",
          "No approved operation-specific native-process command contract is configured",
          {
            profileDomain: validated.profile.domain,
            operation: validated.profile.operation,
            contractIdentity: validated.profile.contractIdentity
          }
        );
      }
      const approved = validator.assertApproved(validated);
      const revalidated = validateNativeProcessPlanV1(approved);
      if (canonicalJson(revalidated) !== canonicalJson(validated)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Approved native-process validator substituted the persisted command plan",
          { validatorId: validator.validatorId }
        );
      }
      return validated;
    }
  });
};

export interface ApprovedNativeProcessContractValidatorV2 {
  readonly validatorId: string;
  readonly profileDomain: NativeProcessProfileDomainV1;
  readonly operations: readonly NativeProcessOperationV1[];
  readonly contractIdentity: CanonicalIdentity;
  assertApproved(plan: NativeProcessPlanV2): NativeProcessPlanV2;
}

export interface ApprovedNativeProcessContractRegistryV2 {
  assertApproved(plan: NativeProcessPlanV2): NativeProcessPlanV2;
}

/** Current registry; V1 registries cannot admit a V2 ledger record. */
export const createApprovedNativeProcessContractRegistryV2 = (
  validators: readonly ApprovedNativeProcessContractValidatorV2[]
): ApprovedNativeProcessContractRegistryV2 => {
  const byKey = new Map<string, ApprovedNativeProcessContractValidatorV2>();
  for (const validator of validators) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(validator.validatorId) ||
      !["kicad", "firmware"].includes(validator.profileDomain) ||
      validator.operations.length === 0 ||
      new Set(validator.operations).size !== validator.operations.length ||
      !canonicalIdentitySchema.safeParse(validator.contractIdentity).success ||
      typeof validator.assertApproved !== "function" ||
      (validator.profileDomain === "kicad"
        ? validator.contractIdentity.schemaVersion !== "evleda.kicad-runtime-command-contract.v1"
        : validator.contractIdentity.schemaVersion !== "evleda.firmware-runtime-command-contract.v1")
    ) {
      throw new DomainError("INVALID_ARGUMENT", "Approved native-process V2 validator is malformed", {
        validatorId: validator.validatorId
      });
    }
    for (const operation of validator.operations) {
      if (!allowedOperations[validator.profileDomain].has(operation)) {
        throw new DomainError("INVALID_ARGUMENT", "V2 validator operation crosses its profile domain", {
          validatorId: validator.validatorId,
          profileDomain: validator.profileDomain,
          operation
        });
      }
      const profile = {
        schemaVersion: validator.profileDomain === "kicad"
          ? "evleda.native-process-profile.kicad.v1" as const
          : "evleda.native-process-profile.firmware.v1" as const,
        domain: validator.profileDomain,
        operation,
        contractIdentity: validator.contractIdentity
      } as NativeProcessProfileV1;
      const key = nativeProcessContractRegistryKey(profile);
      if (byKey.has(key)) {
        throw new DomainError("INVALID_ARGUMENT", "Duplicate approved native-process V2 contract", {
          validatorId: validator.validatorId,
          profileDomain: validator.profileDomain,
          operation
        });
      }
      byKey.set(key, Object.freeze({
        validatorId: validator.validatorId,
        profileDomain: validator.profileDomain,
        operations: Object.freeze([...validator.operations]),
        contractIdentity: structuredClone(validator.contractIdentity),
        assertApproved: validator.assertApproved
      }));
    }
  }

  return Object.freeze({
    assertApproved(plan: NativeProcessPlanV2): NativeProcessPlanV2 {
      const validated = validateNativeProcessPlanV2(plan);
      const validator = byKey.get(nativeProcessContractRegistryKey(validated.profile));
      if (validator === undefined) {
        throw new DomainError(
          "CAPABILITY_REQUIRED",
          "No approved operation-specific native-process V2 command contract is configured",
          {
            profileDomain: validated.profile.domain,
            operation: validated.profile.operation,
            contractIdentity: validated.profile.contractIdentity
          }
        );
      }
      const approved = validator.assertApproved(validated);
      const revalidated = validateNativeProcessPlanV2(approved);
      if (canonicalJson(revalidated) !== canonicalJson(validated)) {
        throw new DomainError(
          "ARTIFACT_INTEGRITY_ERROR",
          "Approved native-process V2 validator substituted the persisted command plan",
          { validatorId: validator.validatorId }
        );
      }
      return validated;
    }
  });
};

import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";

import {
  canonicalPortableJson,
  capturePortableRawBytes,
  hardenPortableValue,
  portableCanonicalIdentity,
  portableContentIdentity,
  parsePrivateRawCaptureReceiptV2Bytes,
  validateCanonicalIdentity,
  validateContentIdentity,
  validatePortablePdfNotRunV2,
  validatePortableSourceBindingV1,
  validatePublicPortableSemanticsV2,
  validateRawBoundPortableReceiptV2,
  validateToolContentIdentityV1,
  withPrivateRawCaptureReceiptV2Identities,
  type PortablePdfNotRunV2,
  type PortableReportKind,
  type PrivateRawCaptureReceiptV2,
  type PublicPortableSemanticsV2,
  type RawBoundPortableReceiptV2,
  type ToolContentIdentityV1,
  type TypedCommandPlanV1,
} from "../core/portable-artifact.js";
import { DomainError } from "../domain/errors.js";
import {
  assertNewToolInvocationRecord,
  completeToolInvocationRecord,
  portableReceiptInvocationIdentityV1,
  toolInvocationIdentityV2,
  toolInvocationRecordSchema,
} from "../domain/invocation-ledger.js";
import type {
  CanonicalIdentity,
  ContentIdentity,
  NativeProcessPlanV2,
  ToolInvocationRecord,
} from "../domain/types.js";
import {
  parseCanonicalPrivateKicadFullResultV1Bytes,
  withPrivateKicadFullResultIdentity,
} from "../persistence/private-kicad-capture-store.js";
import type {
  PrivateKicadCaptureFiles,
  PrivateKicadFullResultV1,
} from "../persistence/private-kicad-capture-port.js";
import type {
  KicadBackendRequestV3,
  KicadBackendResultV3,
  KicadBackendStage,
  KicadPortableExecutionContextV3,
  KicadPortableInvocationBindingV3,
  KicadPortableOperationSuccessV3,
  KicadPortablePdfResultV3,
  KicadPortableRejectedOperationV3,
  KicadPortableOperationRequestBindingV3,
  KicadPortableOperationResultV3,
  KicadPortableSourceRelationV3,
} from "../workflow/contracts.js";
import {
  BoundedProcessError,
  ProcessAbortError,
  ProcessOutputLimitError,
  ProcessTimeoutError,
  runBoundedProcess,
  type BoundedProcessResult,
  type BoundedProcessRunner,
} from "./bounded-process.js";
import {
  normalizeKiCadD356,
  normalizeKiCadDrc,
  normalizeKiCadErc,
  normalizeKiCadNetlist,
  normalizeKiCadPdfV2,
  normalizeKiCadStats,
  validatePortableNormalizationResultV2,
  verifyPortableNormalizationCompoundV2,
  verifyPortablePdfCompoundV2,
  type PortableCompoundVerificationV2,
  type PortableNormalizationBindingsV2,
  type PortableNormalizationResultV2,
  type PortablePdfCompoundVerificationV2,
} from "./kicad-validation-normalizer.js";
import {
  REVIEWED_KICAD_D356_REV_A_PROFILE_V1,
  assertApprovedPortableKicadNativeProcessPlanV2,
  buildPortableKicadNativeContractV2,
  buildPortableKicadNormalizerContractV2,
  buildPortableKicadSourceIdentitySetV1,
  PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1,
  type PortableKicadCommandKindV1,
  type ResolvedPrivateKicadInvocationV2,
} from "./portable-kicad-runtime.js";
import { projectNativeProcessPlanV2ToLegacyV1 } from "../domain/native-process-plan.js";

const REQUEST_SCHEMA = "evleda.kicad-request.v3" as const;
const RESULT_SCHEMA = "evleda.kicad-result.v3" as const;
const OPERATION_BINDING_SCHEMA =
  "evleda.kicad-portable-operation-request-binding.v3" as const;
const OPERATION_RESULT_SCHEMA = "evleda.kicad-portable-operation-result.v3" as const;
const EXECUTION_CONTEXT_SCHEMA = "evleda.kicad-portable-execution-context.v3" as const;
const INVOCATION_BINDING_SCHEMA = "evleda.kicad-portable-invocation-binding.v3" as const;
const SOURCE_RELATION_SCHEMA = "evleda.kicad-portable-source-relation.v3" as const;
const PRIVATE_RUNTIME_METADATA_SCHEMA = "evleda.private-kicad-runtime-metadata.v3" as const;
const REJECTION_SCHEMA = "evleda.private-kicad-runtime-rejection.v2" as const;
const MAX_NATIVE_ARTIFACT_BYTES = 16_777_216;
const SHA256 = /^[0-9a-f]{64}$/u;
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const COMMAND_ORDER = Object.freeze([
  "kicad_erc",
  "kicad_drc",
  "kicad_netlist",
  "kicad_stats",
  "kicad_d356",
  "kicad_pdf",
] as const satisfies readonly PortableKicadCommandKindV1[]);
const commandIndex = new Map<PortableKicadCommandKindV1, number>(
  COMMAND_ORDER.map((kind, index) => [kind, index]),
);

export type PrivateKicadRuntimeFailureClassV1 =
  | "source_snapshot"
  | "spawn"
  | "timeout"
  | "cancelled"
  | "nonaccepted_exit"
  | "output_limit"
  | "output_missing"
  | "runner_contract"
  | "source_changed"
  | "normalization";

export interface PrivateKicadRuntimeRejectionV2 {
  readonly schemaVersion: typeof REJECTION_SCHEMA;
  readonly authority: "private-runtime-consistency-only";
  readonly commandKind: PortableKicadCommandKindV1;
  readonly failureClass: PrivateKicadRuntimeFailureClassV1;
  readonly nativeProcessPlanIdentity: CanonicalIdentity;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly runtimeBinding: KicadPortableInvocationBindingV3;
  readonly sourceContentIdentity: ContentIdentity | null;
  readonly rawContentIdentity: ContentIdentity | null;
  readonly stdoutIdentity: ContentIdentity;
  readonly stderrIdentity: ContentIdentity;
  readonly processOutcome: Exclude<ToolInvocationRecord["outcome"], "unknown">;
  readonly exitCode: number | null;
  readonly publicSemantics: null;
  readonly rawBoundReceipt: null;
  readonly capturedAt: string;
  readonly timestampDisposition: "excluded-private";
  readonly releaseAuthorized: false;
  readonly rejectionIdentity: CanonicalIdentity;
}

export interface PrivateKicadOutputReservationV3 {
  readonly path: string;
  readonly maxBytes: number;
  readonly createdFresh: true;
  readonly initialContentIdentity: ContentIdentity;
  readonly device: string;
  readonly inode: string;
}

export interface PrivateKicadRuntimeMetadataV3 {
  readonly schemaVersion: typeof PRIVATE_RUNTIME_METADATA_SCHEMA;
  readonly disposition: "detached-private-runtime-metadata";
  readonly commandKind: PortableKicadCommandKindV1;
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly expectedOutputs: readonly PrivateKicadOutputReservationV3[];
  readonly acceptedExitCodes: readonly number[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly nativeProcessPlanIdentity: CanonicalIdentity;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly invocationInputSourceIdentity: ContentIdentity;
  readonly metadataIdentity: CanonicalIdentity;
}

export interface PrivatePortableKicadExecutionOperationV3 {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly nativeProcessPlan: NativeProcessPlanV2;
  readonly pendingInvocation: ToolInvocationRecord;
  readonly resolution: ResolvedPrivateKicadInvocationV2;
}

export interface PortableKicadProducerExecutionRequestV3 {
  readonly publicRequest: KicadBackendRequestV3;
  readonly normalizer: ToolContentIdentityV1;
  readonly operations: readonly PrivatePortableKicadExecutionOperationV3[];
}

export interface DetachedPrivateKicadCaptureDraftV3 {
  readonly disposition: "detached-private-capture-draft";
  readonly commandKind: PortableKicadCommandKindV1;
  readonly files: PrivateKicadCaptureFiles;
  readonly invocationInputSourceBytes: Uint8Array;
  readonly privateReceipt: PrivateRawCaptureReceiptV2;
  readonly fullResult: PrivateKicadFullResultV1;
  readonly terminalInvocation: ToolInvocationRecord;
  readonly runtimeMetadata: PrivateKicadRuntimeMetadataV3;
  readonly compoundVerification:
    | PortableCompoundVerificationV2
    | PortablePdfCompoundVerificationV2;
}

export interface DetachedPrivateKicadRejectionDraftV3 {
  readonly disposition: "detached-private-rejection-draft";
  readonly commandKind: PortableKicadCommandKindV1;
  readonly rejection: PrivateKicadRuntimeRejectionV2;
  readonly sourceBytes: Uint8Array;
  readonly invocationInputSourceBytes: Uint8Array;
  readonly rawBytes: Uint8Array;
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
  readonly terminalInvocation: ToolInvocationRecord;
  readonly runtimeMetadata: PrivateKicadRuntimeMetadataV3;
}

export type DetachedPrivateKicadOperationDraftV3 =
  | DetachedPrivateKicadCaptureDraftV3
  | DetachedPrivateKicadRejectionDraftV3;

export interface PortableKicadProducerExecutionV3 {
  readonly publicResult: KicadBackendResultV3;
  readonly privateDrafts: readonly DetachedPrivateKicadOperationDraftV3[];
}

export interface PortableKicadProducerV3Options {
  readonly runner?: BoundedProcessRunner;
  readonly now?: () => string;
}

export interface PortableKicadGenerationBackendV3 {
  readonly backendId: "evleda.portable-kicad-producer.v3";
  execute(execution: PortableKicadProducerExecutionRequestV3): Promise<PortableKicadProducerExecutionV3>;
}

export class PortableKicadProducerV3Error extends DomainError {
  public constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("ARTIFACT_INTEGRITY_ERROR", message, details);
    this.name = "PortableKicadProducerV3Error";
  }
}

const fail = (
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never => {
  throw new PortableKicadProducerV3Error(message, details);
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return fail(`${label} must be a plain non-proxy object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined;
    })
  ) {
    return fail(`${label} fields must be exact enumerable data properties.`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const same = (left: unknown, right: unknown): boolean =>
  canonicalPortableJson(left) === canonicalPortableJson(right);

const exactTimestamp = (value: string): boolean => {
  if (!/^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const asCommandKind = (value: unknown, label: string): PortableKicadCommandKindV1 => {
  if (typeof value !== "string" || !COMMAND_ORDER.includes(value as PortableKicadCommandKindV1)) {
    return fail(`${label} is not an approved KiCad operation.`);
  }
  return value as PortableKicadCommandKindV1;
};

const executionContextPreimage = (
  value: Omit<KicadPortableExecutionContextV3, "contextIdentity">,
): Omit<KicadPortableExecutionContextV3, "contextIdentity"> => value;

const validateExecutionContext = (value: unknown): KicadPortableExecutionContextV3 => {
  const safe = exactRecord(value, [
    "schemaVersion", "projectId", "runId", "attemptId", "stage", "fencingEpoch",
    "inputManifest", "executionFenceIdentity", "sourceRevisionDigest", "contextIdentity",
  ], "KiCad v3 execution context");
  if (
    safe.schemaVersion !== EXECUTION_CONTEXT_SCHEMA ||
    typeof safe.projectId !== "string" || !INVOCATION_ID.test(safe.projectId) ||
    typeof safe.runId !== "string" || !INVOCATION_ID.test(safe.runId) ||
    typeof safe.attemptId !== "string" || !INVOCATION_ID.test(safe.attemptId) ||
    !["schematic", "pcb_placement_routing", "manufacturing_package"].includes(String(safe.stage)) ||
    typeof safe.fencingEpoch !== "number" || !Number.isSafeInteger(safe.fencingEpoch) || safe.fencingEpoch < 1 ||
    typeof safe.sourceRevisionDigest !== "string" || !SHA256.test(safe.sourceRevisionDigest)
  ) {
    return fail("KiCad v3 execution context is invalid.");
  }
  const inputManifest = validateCanonicalIdentity(safe.inputManifest, "$context/inputManifest");
  const executionFenceIdentity = validateCanonicalIdentity(
    safe.executionFenceIdentity,
    "$context/executionFenceIdentity",
  );
  const preimage = executionContextPreimage({
    schemaVersion: EXECUTION_CONTEXT_SCHEMA,
    projectId: safe.projectId,
    runId: safe.runId,
    attemptId: safe.attemptId,
    stage: safe.stage as KicadBackendStage,
    fencingEpoch: safe.fencingEpoch,
    inputManifest,
    executionFenceIdentity,
    sourceRevisionDigest: safe.sourceRevisionDigest,
  });
  const contextIdentity = validateCanonicalIdentity(safe.contextIdentity, "$context/contextIdentity");
  if (
    executionFenceIdentity.schemaVersion !== "evleda.stage-execution-fence.v1" ||
    contextIdentity.schemaVersion !== EXECUTION_CONTEXT_SCHEMA ||
    !same(contextIdentity, portableCanonicalIdentity(preimage, EXECUTION_CONTEXT_SCHEMA))
  ) {
    return fail("KiCad v3 execution context identity does not reproduce its preimage.");
  }
  return Object.freeze({ ...preimage, contextIdentity });
};

const validateOperationBinding = (
  value: unknown,
  label: string,
): KicadPortableOperationRequestBindingV3 => {
  const safe = exactRecord(value, [
    "schemaVersion",
    "commandKind",
    "nativeProcessPlanIdentity",
    "portableReceiptPlanIdentityV1",
    "commandPlanIdentity",
    "invocationId",
  ], label);
  if (safe.schemaVersion !== OPERATION_BINDING_SCHEMA) {
    return fail(`${label} schema is unsupported.`);
  }
  const commandKind = asCommandKind(safe.commandKind, `${label} command kind`);
  const nativeProcessPlanIdentity = validateCanonicalIdentity(
    safe.nativeProcessPlanIdentity,
    `${label}/nativeProcessPlanIdentity`,
  );
  const commandPlanIdentity = validateCanonicalIdentity(
    safe.commandPlanIdentity,
    `${label}/commandPlanIdentity`,
  );
  const portableReceiptPlanIdentityV1 = validateCanonicalIdentity(
    safe.portableReceiptPlanIdentityV1,
    `${label}/portableReceiptPlanIdentityV1`,
  );
  if (
    nativeProcessPlanIdentity.schemaVersion !== "evleda.native-process-plan.v2" ||
    portableReceiptPlanIdentityV1.schemaVersion !== "evleda.native-process-plan.v1" ||
    commandPlanIdentity.schemaVersion !== "evleda.typed-command-plan.v1" ||
    typeof safe.invocationId !== "string" ||
    !INVOCATION_ID.test(safe.invocationId)
  ) {
    return fail(`${label} identity domain is invalid.`);
  }
  return Object.freeze({
    schemaVersion: OPERATION_BINDING_SCHEMA,
    commandKind,
    nativeProcessPlanIdentity: nativeProcessPlanIdentity as KicadPortableOperationRequestBindingV3["nativeProcessPlanIdentity"],
    portableReceiptPlanIdentityV1: portableReceiptPlanIdentityV1 as KicadPortableOperationRequestBindingV3["portableReceiptPlanIdentityV1"],
    commandPlanIdentity,
    invocationId: safe.invocationId,
  });
};

const requestPreimage = (
  value: Omit<KicadBackendRequestV3, "requestIdentity">,
): Omit<KicadBackendRequestV3, "requestIdentity"> => value;

export const validateKicadBackendRequestV3 = (value: unknown): KicadBackendRequestV3 => {
  const safe = exactRecord(hardenPortableValue(value), [
    "schemaVersion",
    "stage",
    "expectedSourceRevisionDigest",
    "executionContext",
    "operationBindings",
    "lifecycle",
    "hostAuthenticated",
    "manufactureReady",
    "releaseAuthorized",
    "requestIdentity",
  ], "KiCad v3 request");
  if (
    safe.schemaVersion !== REQUEST_SCHEMA ||
    !["schematic", "pcb_placement_routing", "manufacturing_package"].includes(String(safe.stage)) ||
    typeof safe.expectedSourceRevisionDigest !== "string" ||
    !SHA256.test(safe.expectedSourceRevisionDigest) ||
    !Array.isArray(safe.operationBindings) ||
    safe.operationBindings.length < 1 ||
    safe.operationBindings.length > COMMAND_ORDER.length ||
    safe.lifecycle !== "candidate" ||
    safe.hostAuthenticated !== false ||
    safe.manufactureReady !== false ||
    safe.releaseAuthorized !== false
  ) {
    return fail("KiCad v3 request has an unsupported or authority-escalating envelope.");
  }
  const operationBindings = safe.operationBindings.map((binding, index) =>
    validateOperationBinding(binding, `KiCad v3 request operation ${index}`));
  const executionContext = validateExecutionContext(safe.executionContext);
  if (
    new Set(operationBindings.map((binding) => binding.commandKind)).size !== operationBindings.length ||
    new Set(operationBindings.map((binding) => binding.invocationId)).size !== operationBindings.length ||
    operationBindings.some((binding, index) =>
      index > 0 &&
      commandIndex.get(operationBindings[index - 1]!.commandKind)! >=
        commandIndex.get(binding.commandKind)!)
  ) {
    return fail("KiCad v3 operations must be unique and in the fixed contract order.");
  }
  if (
    executionContext.stage !== safe.stage ||
    executionContext.sourceRevisionDigest !== safe.expectedSourceRevisionDigest
  ) {
    return fail("KiCad v3 request source revision is detached from its execution context.");
  }
  const preimage = Object.freeze({
    schemaVersion: REQUEST_SCHEMA,
    stage: safe.stage as KicadBackendStage,
    expectedSourceRevisionDigest: safe.expectedSourceRevisionDigest,
    executionContext,
    operationBindings: Object.freeze(operationBindings),
    lifecycle: "candidate" as const,
    hostAuthenticated: false as const,
    manufactureReady: false as const,
    releaseAuthorized: false as const,
  });
  const requestIdentity = validateCanonicalIdentity(safe.requestIdentity, "$request/requestIdentity");
  const expectedIdentity = portableCanonicalIdentity(preimage, REQUEST_SCHEMA);
  if (requestIdentity.schemaVersion !== REQUEST_SCHEMA || !same(requestIdentity, expectedIdentity)) {
    return fail("KiCad v3 request identity does not reproduce its exact public preimage.");
  }
  return Object.freeze({ ...preimage, requestIdentity });
};

export const buildKicadBackendRequestV3 = (input: {
  readonly stage: KicadBackendStage;
  readonly expectedSourceRevisionDigest: string;
  readonly operations: readonly PrivatePortableKicadExecutionOperationV3[];
}): KicadBackendRequestV3 => {
  if (!Array.isArray(input.operations) || input.operations.length < 1) {
    return fail("KiCad v3 request requires at least one private operation draft.");
  }
  const pendingRecords = input.operations.map((operation) => {
    const parsed = toolInvocationRecordSchema.safeParse(operation.pendingInvocation);
    if (!parsed.success) return fail("KiCad v3 request received an invalid W08 invocation draft.");
    const pending = parsed.data as ToolInvocationRecord;
    assertNewToolInvocationRecord(pending);
    return pending;
  });
  const firstPending = pendingRecords[0]!;
  const contextDraft = executionContextPreimage({
    schemaVersion: EXECUTION_CONTEXT_SCHEMA,
    projectId: firstPending.projectId,
    runId: firstPending.runId,
    attemptId: firstPending.attemptId,
    stage: input.stage,
    fencingEpoch: firstPending.fencingEpoch,
    inputManifest: firstPending.inputManifest,
    executionFenceIdentity: portableCanonicalIdentity(
      firstPending.executionFence,
      "evleda.stage-execution-fence.v1",
    ),
    sourceRevisionDigest: input.expectedSourceRevisionDigest,
  });
  const executionContext = validateExecutionContext({
    ...contextDraft,
    contextIdentity: portableCanonicalIdentity(contextDraft, EXECUTION_CONTEXT_SCHEMA),
  });
  if (pendingRecords.some((pending) =>
    pending.projectId !== executionContext.projectId ||
    pending.runId !== executionContext.runId ||
    pending.attemptId !== executionContext.attemptId ||
    pending.stage !== executionContext.stage ||
    pending.fencingEpoch !== executionContext.fencingEpoch ||
    !same(pending.inputManifest, executionContext.inputManifest) ||
    !same(
      portableCanonicalIdentity(pending.executionFence, "evleda.stage-execution-fence.v1"),
      executionContext.executionFenceIdentity,
    ))) {
    return fail("KiCad v3 request operations do not share one W08 execution context.");
  }
  const operationBindings = [...input.operations]
    .sort((left, right) => commandIndex.get(left.commandKind)! - commandIndex.get(right.commandKind)!)
    .map((operation): KicadPortableOperationRequestBindingV3 => {
      const plan = assertApprovedPortableKicadNativeProcessPlanV2(operation.nativeProcessPlan);
      if (plan.profile.operation !== operation.commandKind || plan.command.kind !== "portable_typed_command_v1") {
        return fail("KiCad v3 request operation does not match its approved process plan.");
      }
      return Object.freeze({
        schemaVersion: OPERATION_BINDING_SCHEMA,
        commandKind: operation.commandKind,
        nativeProcessPlanIdentity: plan.planIdentity,
        portableReceiptPlanIdentityV1: projectNativeProcessPlanV2ToLegacyV1(plan).planIdentity,
        commandPlanIdentity: plan.command.value.commandPlanIdentity,
        invocationId: operation.pendingInvocation.id,
      });
    });
  const preimage = requestPreimage({
    schemaVersion: REQUEST_SCHEMA,
    stage: input.stage,
    expectedSourceRevisionDigest: input.expectedSourceRevisionDigest,
    executionContext,
    operationBindings,
    lifecycle: "candidate",
    hostAuthenticated: false,
    manufactureReady: false,
    releaseAuthorized: false,
  });
  return validateKicadBackendRequestV3({
    ...preimage,
    requestIdentity: portableCanonicalIdentity(preimage, REQUEST_SCHEMA),
  });
};

const assertPublicFieldNames = (value: unknown): void => {
  const forbidden = new Set([
    "argv",
    "cwd",
    "stdout",
    "stderr",
    "startedAt",
    "completedAt",
    "capturedAt",
    "executablePath",
    "command",
  ]);
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (forbidden.has(key)) fail("KiCad v3 public result contains private runtime material.", { field: key });
      visit(child);
    }
  };
  visit(value);
};

const invocationBindingPreimage = (
  value: Omit<KicadPortableInvocationBindingV3, "bindingIdentity">,
): Omit<KicadPortableInvocationBindingV3, "bindingIdentity"> => value;

const validateInvocationBinding = (
  value: unknown,
  expected: KicadPortableOperationRequestBindingV3,
  executionContext: KicadPortableExecutionContextV3,
): KicadPortableInvocationBindingV3 => {
  const safe = exactRecord(value, [
    "schemaVersion", "invocationId", "executionContextIdentity",
    "nativeProcessPlanIdentity", "portableReceiptPlanIdentityV1", "commandPlanIdentity",
    "authoritativeInvocationIdentityV2", "portableReceiptInvocationIdentityV1",
    "compatibilityDisposition", "bindingIdentity",
  ], "KiCad v3 invocation binding");
  const authoritativeInvocationIdentityV2 = validateCanonicalIdentity(
    safe.authoritativeInvocationIdentityV2,
    "$runtimeBinding/authoritativeInvocationIdentityV2",
  );
  const portableReceiptInvocationIdentityV1 = validateCanonicalIdentity(
    safe.portableReceiptInvocationIdentityV1,
    "$runtimeBinding/portableReceiptInvocationIdentityV1",
  );
  const nativeProcessPlanIdentity = validateCanonicalIdentity(
    safe.nativeProcessPlanIdentity,
    "$runtimeBinding/nativeProcessPlanIdentity",
  );
  const portableReceiptPlanIdentityV1 = validateCanonicalIdentity(
    safe.portableReceiptPlanIdentityV1,
    "$runtimeBinding/portableReceiptPlanIdentityV1",
  );
  const commandPlanIdentity = validateCanonicalIdentity(
    safe.commandPlanIdentity,
    "$runtimeBinding/commandPlanIdentity",
  );
  const executionContextIdentity = validateCanonicalIdentity(
    safe.executionContextIdentity,
    "$runtimeBinding/executionContextIdentity",
  );
  if (
    safe.schemaVersion !== INVOCATION_BINDING_SCHEMA ||
    safe.invocationId !== expected.invocationId ||
    safe.compatibilityDisposition !== "phase1-receipt-projection-only" ||
    authoritativeInvocationIdentityV2.schemaVersion !== "evleda.tool-invocation.v2" ||
    portableReceiptInvocationIdentityV1.schemaVersion !== "evleda.tool-invocation.v1" ||
    nativeProcessPlanIdentity.schemaVersion !== "evleda.native-process-plan.v2" ||
    portableReceiptPlanIdentityV1.schemaVersion !== "evleda.native-process-plan.v1" ||
    commandPlanIdentity.schemaVersion !== "evleda.typed-command-plan.v1" ||
    !same(executionContextIdentity, executionContext.contextIdentity) ||
    !same(nativeProcessPlanIdentity, expected.nativeProcessPlanIdentity) ||
    !same(portableReceiptPlanIdentityV1, expected.portableReceiptPlanIdentityV1) ||
    !same(commandPlanIdentity, expected.commandPlanIdentity)
  ) {
    return fail("KiCad v3 invocation binding is detached from its request or identity domains.");
  }
  const preimage = invocationBindingPreimage({
    schemaVersion: INVOCATION_BINDING_SCHEMA,
    invocationId: expected.invocationId,
    executionContextIdentity,
    nativeProcessPlanIdentity: nativeProcessPlanIdentity as KicadPortableInvocationBindingV3["nativeProcessPlanIdentity"],
    portableReceiptPlanIdentityV1: portableReceiptPlanIdentityV1 as KicadPortableInvocationBindingV3["portableReceiptPlanIdentityV1"],
    commandPlanIdentity,
    authoritativeInvocationIdentityV2,
    portableReceiptInvocationIdentityV1,
    compatibilityDisposition: "phase1-receipt-projection-only",
  });
  const bindingIdentity = validateCanonicalIdentity(safe.bindingIdentity, "$runtimeBinding/bindingIdentity");
  if (
    bindingIdentity.schemaVersion !== INVOCATION_BINDING_SCHEMA ||
    !same(bindingIdentity, portableCanonicalIdentity(preimage, INVOCATION_BINDING_SCHEMA))
  ) {
    return fail("KiCad v3 invocation binding identity does not reproduce its preimage.");
  }
  return Object.freeze({ ...preimage, bindingIdentity });
};

const validateStandaloneInvocationBinding = (
  value: unknown,
  commandKind: PortableKicadCommandKindV1,
): KicadPortableInvocationBindingV3 => {
  const safe = exactRecord(value, [
    "schemaVersion", "invocationId", "executionContextIdentity",
    "nativeProcessPlanIdentity", "portableReceiptPlanIdentityV1", "commandPlanIdentity",
    "authoritativeInvocationIdentityV2", "portableReceiptInvocationIdentityV1",
    "compatibilityDisposition", "bindingIdentity",
  ], "Detached KiCad v3 invocation binding");
  return validateInvocationBinding(value, {
    schemaVersion: OPERATION_BINDING_SCHEMA,
    commandKind,
    nativeProcessPlanIdentity: safe.nativeProcessPlanIdentity as KicadPortableOperationRequestBindingV3["nativeProcessPlanIdentity"],
    portableReceiptPlanIdentityV1: safe.portableReceiptPlanIdentityV1 as KicadPortableOperationRequestBindingV3["portableReceiptPlanIdentityV1"],
    commandPlanIdentity: safe.commandPlanIdentity as CanonicalIdentity,
    invocationId: String(safe.invocationId),
  }, {
    contextIdentity: safe.executionContextIdentity as CanonicalIdentity,
  } as KicadPortableExecutionContextV3);
};

const buildInvocationBinding = (
  terminal: ToolInvocationRecord,
  requestBinding: KicadPortableOperationRequestBindingV3,
  executionContext: KicadPortableExecutionContextV3,
): KicadPortableInvocationBindingV3 => {
  if (
    terminal.invocationIdentity === null ||
    terminal.portableReceiptInvocationIdentityV1 === null ||
    terminal.commandPlan.command.kind !== "portable_typed_command_v1"
  ) {
    return fail("Terminal W08 record lacks its current or compatibility identity.");
  }
  const preimage = invocationBindingPreimage({
    schemaVersion: INVOCATION_BINDING_SCHEMA,
    invocationId: terminal.id,
    executionContextIdentity: executionContext.contextIdentity,
    nativeProcessPlanIdentity: terminal.commandPlanIdentity,
    portableReceiptPlanIdentityV1: projectNativeProcessPlanV2ToLegacyV1(
      terminal.commandPlan,
    ).planIdentity,
    commandPlanIdentity: terminal.commandPlan.command.value.commandPlanIdentity,
    authoritativeInvocationIdentityV2: terminal.invocationIdentity,
    portableReceiptInvocationIdentityV1: terminal.portableReceiptInvocationIdentityV1,
    compatibilityDisposition: "phase1-receipt-projection-only",
  });
  return validateInvocationBinding({
    ...preimage,
    bindingIdentity: portableCanonicalIdentity(preimage, INVOCATION_BINDING_SCHEMA),
  }, requestBinding, executionContext);
};

const sourceRelationPreimage = (
  value: Omit<KicadPortableSourceRelationV3, "relationIdentity">,
): Omit<KicadPortableSourceRelationV3, "relationIdentity"> => value;

const buildSourceRelation = (
  commandKind: PortableKicadCommandKindV1,
  invocationInputSourceIdentity: ContentIdentity,
  evaluatedSourceIdentity: ContentIdentity,
): KicadPortableSourceRelationV3 => {
  const preimage = sourceRelationPreimage({
    schemaVersion: SOURCE_RELATION_SCHEMA,
    evaluation: commandKind === "kicad_drc" ? "post-refill-and-save" : "command-input",
    invocationInputSourceIdentity,
    evaluatedSourceIdentity,
  });
  return Object.freeze({
    ...preimage,
    relationIdentity: portableCanonicalIdentity(preimage, SOURCE_RELATION_SCHEMA),
  });
};

const validateSourceRelation = (
  value: unknown,
  commandKind: PortableKicadCommandKindV1,
  evaluatedIdentity: ContentIdentity,
): KicadPortableSourceRelationV3 => {
  const safe = exactRecord(value, [
    "schemaVersion", "evaluation", "invocationInputSourceIdentity",
    "evaluatedSourceIdentity", "relationIdentity",
  ], "KiCad v3 source relation");
  const inputIdentity = validateContentIdentity(
    safe.invocationInputSourceIdentity,
    "$sourceRelation/invocationInputSourceIdentity",
  );
  const evaluated = validateContentIdentity(
    safe.evaluatedSourceIdentity,
    "$sourceRelation/evaluatedSourceIdentity",
  );
  const preimage = sourceRelationPreimage({
    schemaVersion: SOURCE_RELATION_SCHEMA,
    evaluation: safe.evaluation as KicadPortableSourceRelationV3["evaluation"],
    invocationInputSourceIdentity: inputIdentity,
    evaluatedSourceIdentity: evaluated,
  });
  const relationIdentity = validateCanonicalIdentity(safe.relationIdentity, "$sourceRelation/relationIdentity");
  if (
    safe.schemaVersion !== SOURCE_RELATION_SCHEMA ||
    safe.evaluation !== (commandKind === "kicad_drc" ? "post-refill-and-save" : "command-input") ||
    !same(evaluated, evaluatedIdentity) ||
    (commandKind !== "kicad_drc" && !same(inputIdentity, evaluated)) ||
    relationIdentity.schemaVersion !== SOURCE_RELATION_SCHEMA ||
    !same(relationIdentity, portableCanonicalIdentity(preimage, SOURCE_RELATION_SCHEMA))
  ) {
    return fail("KiCad v3 source relation is invalid or detached from evaluated bytes.");
  }
  return Object.freeze({ ...preimage, relationIdentity });
};

const validatePublicOperation = (
  value: unknown,
  expectedBinding: KicadPortableOperationRequestBindingV3,
  executionContext: KicadPortableExecutionContextV3,
): KicadPortableOperationResultV3 => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    return fail("KiCad v3 public operation must be a plain non-proxy object.");
  }
  const base = exactRecord(value, Object.keys(value), "KiCad v3 public operation");
  if (
    base.schemaVersion !== OPERATION_RESULT_SCHEMA ||
    base.commandKind !== expectedBinding.commandKind ||
    base.hostAuthenticated !== false ||
    base.manufactureReady !== false ||
    base.releaseAuthorized !== false
  ) {
    return fail("KiCad v3 public operation envelope is invalid.");
  }
  const nativeProcessPlanIdentity = validateCanonicalIdentity(
    base.nativeProcessPlanIdentity,
    "$operation/nativeProcessPlanIdentity",
  );
  const commandPlanIdentity = validateCanonicalIdentity(
    base.commandPlanIdentity,
    "$operation/commandPlanIdentity",
  );
  const runtimeBinding = validateInvocationBinding(
    base.runtimeBinding,
    expectedBinding,
    executionContext,
  );
  if (
    !same(nativeProcessPlanIdentity, expectedBinding.nativeProcessPlanIdentity) ||
    !same(commandPlanIdentity, expectedBinding.commandPlanIdentity) ||
    !same(nativeProcessPlanIdentity, runtimeBinding.nativeProcessPlanIdentity) ||
    !same(commandPlanIdentity, runtimeBinding.commandPlanIdentity)
  ) {
    return fail("KiCad v3 public operation identity binding is invalid.");
  }
  if (base.status === "portable_semantics_created") {
    const safe = exactRecord(base, [
      "schemaVersion", "commandKind", "status", "sourceBinding", "sourceRelation", "nativeContractIdentity",
      "normalizerContractIdentity", "nativeProcessPlanIdentity", "commandPlanIdentity",
      "runtimeBinding", "semantics", "rawBoundReceipt", "captureEnvelopeIdentity",
      "privateCaptureIdentity", "compoundVerificationIdentity",
      "hostAuthenticated", "manufactureReady", "releaseAuthorized",
    ], "KiCad v3 portable operation");
    if (expectedBinding.commandKind === "kicad_pdf") return fail("PDF cannot create portable semantics.");
    const semantics = validatePublicPortableSemanticsV2(safe.semantics, "$operation/semantics");
    const rawBoundReceipt = validateRawBoundPortableReceiptV2(safe.rawBoundReceipt, "$operation/rawBoundReceipt");
    const sourceBinding = validatePortableSourceBindingV1(safe.sourceBinding, "$operation/sourceBinding");
    const sourceRelation = validateSourceRelation(
      safe.sourceRelation,
      expectedBinding.commandKind,
      sourceBinding.sourceArtifactIdentity,
    );
    const nativeContractIdentity = validateCanonicalIdentity(safe.nativeContractIdentity, "$operation/nativeContractIdentity");
    const normalizerContractIdentity = validateCanonicalIdentity(safe.normalizerContractIdentity, "$operation/normalizerContractIdentity");
    const compoundVerificationIdentity = validateCanonicalIdentity(safe.compoundVerificationIdentity, "$operation/compoundVerificationIdentity");
    const captureEnvelopeIdentity = validateCanonicalIdentity(safe.captureEnvelopeIdentity, "$operation/captureEnvelopeIdentity");
    const privateCaptureIdentity = validateCanonicalIdentity(safe.privateCaptureIdentity, "$operation/privateCaptureIdentity");
    if (
      semantics.reportKind !== expectedBinding.commandKind ||
      rawBoundReceipt.reportKind !== expectedBinding.commandKind ||
      !same(sourceBinding, semantics.sourceBinding) ||
      !same(sourceBinding, rawBoundReceipt.sourceBinding) ||
      !same(nativeContractIdentity, semantics.nativeContractIdentity) ||
      !same(normalizerContractIdentity, semantics.normalizerContractIdentity) ||
      !same(commandPlanIdentity, semantics.commandPlanIdentity) ||
      !same(commandPlanIdentity, rawBoundReceipt.commandPlanIdentity) ||
      !same(semantics.semanticIdentity, rawBoundReceipt.portableSemanticIdentity) ||
      !same(semantics.documentIdentity, rawBoundReceipt.portableDocumentIdentity) ||
      !same(semantics.normalizer.contentIdentity, rawBoundReceipt.normalizerContentIdentity) ||
      !same(semantics.tool, rawBoundReceipt.toolIdentity) ||
      !same(captureEnvelopeIdentity, rawBoundReceipt.captureIdentity) ||
      captureEnvelopeIdentity.schemaVersion !== "evleda.portable-capture-command-envelope.v1" ||
      privateCaptureIdentity.schemaVersion !== "evleda.raw-capture-key.v2" ||
      compoundVerificationIdentity.schemaVersion !== "evleda.portable-compound-verification.v2"
    ) {
      return fail("KiCad v3 portable operation does not preserve compound coherence.");
    }
    return Object.freeze({
      ...safe,
      commandKind: expectedBinding.commandKind as PortableReportKind,
      sourceBinding,
      sourceRelation,
      nativeContractIdentity,
      normalizerContractIdentity,
      nativeProcessPlanIdentity: nativeProcessPlanIdentity as KicadPortableOperationResultV3["nativeProcessPlanIdentity"],
      commandPlanIdentity,
      runtimeBinding,
      semantics,
      rawBoundReceipt,
      captureEnvelopeIdentity,
      privateCaptureIdentity,
      compoundVerificationIdentity,
    }) as KicadPortableOperationResultV3;
  }
  if (base.status === "private_pdf_not_run_publicly") {
    const safe = exactRecord(base, [
      "schemaVersion", "commandKind", "status", "sourceBinding", "sourceRelation", "nativeContractIdentity",
      "normalizerContractIdentity", "nativeProcessPlanIdentity", "commandPlanIdentity",
      "runtimeBinding", "marker", "privateCaptureIdentity", "compoundVerificationIdentity", "hostAuthenticated",
      "manufactureReady", "releaseAuthorized",
    ], "KiCad v3 PDF operation");
    if (expectedBinding.commandKind !== "kicad_pdf") return fail("Non-PDF operation cannot use the PDF marker.");
    const sourceBinding = validatePortableSourceBindingV1(safe.sourceBinding, "$operation/sourceBinding");
    const sourceRelation = validateSourceRelation(
      safe.sourceRelation,
      "kicad_pdf",
      sourceBinding.sourceArtifactIdentity,
    );
    const nativeContractIdentity = validateCanonicalIdentity(safe.nativeContractIdentity, "$operation/nativeContractIdentity");
    const normalizerContractIdentity = validateCanonicalIdentity(safe.normalizerContractIdentity, "$operation/normalizerContractIdentity");
    const marker = validatePortablePdfNotRunV2(safe.marker, "$operation/marker");
    const compoundVerificationIdentity = validateCanonicalIdentity(safe.compoundVerificationIdentity, "$operation/compoundVerificationIdentity");
    const privateCaptureIdentity = validateCanonicalIdentity(safe.privateCaptureIdentity, "$operation/privateCaptureIdentity");
    if (
      compoundVerificationIdentity.schemaVersion !== "evleda.portable-pdf-compound-verification.v2" ||
      privateCaptureIdentity.schemaVersion !== "evleda.raw-capture-key.v2"
    ) {
      return fail("KiCad v3 PDF verification identity domain is invalid.");
    }
    return Object.freeze({
      ...safe,
      commandKind: "kicad_pdf",
      sourceBinding,
      sourceRelation,
      nativeContractIdentity,
      normalizerContractIdentity,
      nativeProcessPlanIdentity: nativeProcessPlanIdentity as KicadPortableOperationResultV3["nativeProcessPlanIdentity"],
      commandPlanIdentity,
      runtimeBinding,
      marker,
      privateCaptureIdentity,
      compoundVerificationIdentity,
    }) as KicadPortableOperationResultV3;
  }
  if (base.status === "private_runtime_rejected") {
    const safe = exactRecord(base, [
      "schemaVersion", "commandKind", "status", "nativeProcessPlanIdentity",
      "commandPlanIdentity", "runtimeBinding", "privateRejectionIdentity", "semantics",
      "rawBoundReceipt", "hostAuthenticated", "manufactureReady", "releaseAuthorized",
    ], "KiCad v3 rejected operation");
    const privateRejectionIdentity = validateCanonicalIdentity(safe.privateRejectionIdentity, "$operation/privateRejectionIdentity");
    if (
      privateRejectionIdentity.schemaVersion !== REJECTION_SCHEMA ||
      safe.semantics !== null ||
      safe.rawBoundReceipt !== null
    ) {
      return fail("KiCad v3 rejected operation attempted to create public semantics.");
    }
    return Object.freeze({
      ...safe,
      commandKind: expectedBinding.commandKind,
      nativeProcessPlanIdentity: nativeProcessPlanIdentity as KicadPortableOperationResultV3["nativeProcessPlanIdentity"],
      commandPlanIdentity,
      runtimeBinding,
      privateRejectionIdentity,
    }) as KicadPortableOperationResultV3;
  }
  return fail("KiCad v3 operation status is unsupported.");
};

export const validateKicadBackendResultV3 = (
  value: unknown,
  requestValue: unknown,
): KicadBackendResultV3 => {
  const request = validateKicadBackendRequestV3(requestValue);
  const safe = exactRecord(hardenPortableValue(value), [
    "schemaVersion", "stage", "sourceRevisionDigest", "requestIdentity", "operations",
    "lifecycle", "hostAuthenticated", "manufactureReady", "qualificationAuthorized",
    "releaseAuthorized", "resultIdentity",
  ], "KiCad v3 result");
  if (
    safe.schemaVersion !== RESULT_SCHEMA ||
    safe.stage !== request.stage ||
    safe.sourceRevisionDigest !== request.expectedSourceRevisionDigest ||
    !same(safe.requestIdentity, request.requestIdentity) ||
    !Array.isArray(safe.operations) ||
    safe.operations.length !== request.operationBindings.length ||
    safe.lifecycle !== "candidate" ||
    safe.hostAuthenticated !== false ||
    safe.manufactureReady !== false ||
    safe.qualificationAuthorized !== false ||
    safe.releaseAuthorized !== false
  ) {
    return fail("KiCad v3 result has an unsupported or authority-escalating envelope.");
  }
  const operations = safe.operations.map((operation, index) =>
    validatePublicOperation(
      operation,
      request.operationBindings[index]!,
      request.executionContext,
    ));
  const preimage = Object.freeze({
    schemaVersion: RESULT_SCHEMA,
    stage: request.stage,
    sourceRevisionDigest: request.expectedSourceRevisionDigest,
    requestIdentity: request.requestIdentity,
    operations: Object.freeze(operations),
    lifecycle: "candidate" as const,
    hostAuthenticated: false as const,
    manufactureReady: false as const,
    qualificationAuthorized: false as const,
    releaseAuthorized: false as const,
  });
  assertPublicFieldNames(preimage);
  const resultIdentity = validateCanonicalIdentity(safe.resultIdentity, "$result/resultIdentity");
  const expectedIdentity = portableCanonicalIdentity(preimage, RESULT_SCHEMA);
  if (resultIdentity.schemaVersion !== RESULT_SCHEMA || !same(resultIdentity, expectedIdentity)) {
    return fail("KiCad v3 result identity does not reproduce its exact public preimage.");
  }
  return Object.freeze({ ...preimage, resultIdentity });
};

interface StableBytes {
  readonly bytes: Buffer;
  readonly identity: ContentIdentity;
}

interface StableFileSnapshot extends StableBytes {
  readonly device: string;
  readonly inode: string;
}

const captureStableFile = async (
  filePath: string,
  maximumBytes: number,
  label: string,
  expectedFile?: { readonly device: string; readonly inode: string },
): Promise<StableFileSnapshot> => {
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (before.size > maximumBytes) {
      return fail(`${label} exceeds its closed byte limit.`, { fileCaptureFailure: "limit" });
    }
    if (!before.isFile() || before.size < 1 || before.nlink !== 1) {
      return fail(`${label} is not a bounded single-link regular file.`);
    }
    if (
      expectedFile !== undefined &&
      (String(before.dev) !== expectedFile.device || String(before.ino) !== expectedFile.inode)
    ) {
      return fail(`${label} is not the output file reserved for this invocation.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      after.size !== bytes.byteLength
    ) {
      return fail(`${label} changed while it was captured.`);
    }
    return Object.freeze({
      bytes: Buffer.from(bytes),
      identity: portableContentIdentity(bytes),
      device: String(after.dev),
      inode: String(after.ino),
    });
  } finally {
    await handle.close();
  }
};

interface FreshOutputReservation {
  readonly path: string;
  readonly maxBytes: number;
  readonly device: string;
  readonly inode: string;
}

const reserveFreshOutput = async (
  descriptor: { readonly path: string; readonly maxBytes: number },
): Promise<FreshOutputReservation> => {
  let handle;
  try {
    handle = await open(descriptor.path, "wx");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== 0 || metadata.nlink !== 1) {
      return fail("Fresh KiCad output reservation is not an empty single-link file.");
    }
    return Object.freeze({
      path: descriptor.path,
      maxBytes: descriptor.maxBytes,
      device: String(metadata.dev),
      inode: String(metadata.ino),
    });
  } catch (error) {
    if (error instanceof PortableKicadProducerV3Error) throw error;
    return fail("KiCad output target was not fresh and exclusively reservable.");
  } finally {
    await handle?.close();
  }
};

const rollbackFreshReservations = async (
  reservations: readonly FreshOutputReservation[],
): Promise<void> => {
  for (const reservation of reservations) {
    try {
      const handle = await open(reservation.path, "r");
      try {
        const metadata = await handle.stat();
        if (
          metadata.size !== 0 ||
          String(metadata.dev) !== reservation.device ||
          String(metadata.ino) !== reservation.inode
        ) {
          continue;
        }
      } finally {
        await handle.close();
      }
      await unlink(reservation.path);
    } catch {
      // Best-effort rollback applies only to exact empty files created above.
    }
  }
};

const runtimeMetadataPreimage = (
  value: Omit<PrivateKicadRuntimeMetadataV3, "metadataIdentity">,
): Omit<PrivateKicadRuntimeMetadataV3, "metadataIdentity"> => value;

const buildPrivateRuntimeMetadata = (
  resolution: PrivateResolutionSnapshotV3,
  reservation: FreshOutputReservation,
): PrivateKicadRuntimeMetadataV3 => {
  const initialContentIdentity = portableContentIdentity(Buffer.alloc(0));
  const preimage = runtimeMetadataPreimage({
    schemaVersion: PRIVATE_RUNTIME_METADATA_SCHEMA,
    disposition: "detached-private-runtime-metadata",
    commandKind: resolution.commandKind,
    command: resolution.command,
    argv: resolution.argv,
    cwd: resolution.cwd,
    environment: resolution.environment,
    expectedOutputs: Object.freeze([Object.freeze({
      path: reservation.path,
      maxBytes: reservation.maxBytes,
      createdFresh: true as const,
      initialContentIdentity,
      device: reservation.device,
      inode: reservation.inode,
    })]),
    acceptedExitCodes: resolution.acceptedExitCodes,
    timeoutMs: resolution.timeoutMs,
    maxStdoutBytes: resolution.maxStdoutBytes,
    maxStderrBytes: resolution.maxStderrBytes,
    nativeProcessPlanIdentity: resolution.nativeProcessPlanIdentity,
    commandPlanIdentity: resolution.commandPlanIdentity,
    invocationInputSourceIdentity: resolution.invocationInputSourceIdentity,
  });
  return hardenPortableValue({
    ...preimage,
    metadataIdentity: portableCanonicalIdentity(preimage, PRIVATE_RUNTIME_METADATA_SCHEMA),
  }) as unknown as PrivateKicadRuntimeMetadataV3;
};

export const validatePrivateKicadRuntimeMetadataV3 = (
  value: unknown,
): PrivateKicadRuntimeMetadataV3 => {
  const safe = exactRecord(hardenPortableValue(value), [
    "schemaVersion", "disposition", "commandKind", "command", "argv", "cwd",
    "environment", "expectedOutputs", "acceptedExitCodes", "timeoutMs", "maxStdoutBytes",
    "maxStderrBytes", "nativeProcessPlanIdentity", "commandPlanIdentity",
    "invocationInputSourceIdentity", "metadataIdentity",
  ], "Private KiCad runtime metadata");
  const commandKind = asCommandKind(safe.commandKind, "Private runtime metadata command kind");
  const argv = snapshotStringArray(safe.argv, "Private runtime metadata argv");
  const acceptedExitCodes = snapshotIntegerArray(
    safe.acceptedExitCodes,
    "Private runtime metadata exit codes",
  );
  const environment = snapshotEnvironment(safe.environment);
  const expectedOutputs = snapshotArray(
    safe.expectedOutputs,
    "Private runtime metadata outputs",
    (entry, index): PrivateKicadOutputReservationV3 => {
      const output = exactRecord(entry, [
        "path", "maxBytes", "createdFresh", "initialContentIdentity", "device", "inode",
      ], `Private runtime metadata output ${index}`);
      const initialContentIdentity = validateContentIdentity(
        output.initialContentIdentity,
        `$runtimeMetadata/expectedOutputs/${index}/initialContentIdentity`,
      );
      if (
        typeof output.path !== "string" || !path.isAbsolute(output.path) ||
        typeof output.maxBytes !== "number" || !Number.isSafeInteger(output.maxBytes) || output.maxBytes < 1 ||
        output.createdFresh !== true ||
        !same(initialContentIdentity, portableContentIdentity(Buffer.alloc(0))) ||
        typeof output.device !== "string" || !/^[0-9]+$/u.test(output.device) ||
        typeof output.inode !== "string" || !/^[0-9]+$/u.test(output.inode)
      ) {
        return fail("Private runtime output reservation is invalid.");
      }
      return Object.freeze({
        path: output.path,
        maxBytes: output.maxBytes,
        createdFresh: true,
        initialContentIdentity,
        device: output.device,
        inode: output.inode,
      });
    },
  );
  const nativeProcessPlanIdentity = validateCanonicalIdentity(safe.nativeProcessPlanIdentity);
  const commandPlanIdentity = validateCanonicalIdentity(safe.commandPlanIdentity);
  const invocationInputSourceIdentity = validateContentIdentity(safe.invocationInputSourceIdentity);
  if (
    safe.schemaVersion !== PRIVATE_RUNTIME_METADATA_SCHEMA ||
    safe.disposition !== "detached-private-runtime-metadata" ||
    typeof safe.command !== "string" || !path.isAbsolute(safe.command) ||
    typeof safe.cwd !== "string" || !path.isAbsolute(safe.cwd) ||
    expectedOutputs.length !== 1 ||
    nativeProcessPlanIdentity.schemaVersion !== "evleda.native-process-plan.v2" ||
    commandPlanIdentity.schemaVersion !== "evleda.typed-command-plan.v1" ||
    typeof safe.timeoutMs !== "number" || !Number.isSafeInteger(safe.timeoutMs) || safe.timeoutMs < 1 ||
    typeof safe.maxStdoutBytes !== "number" || !Number.isSafeInteger(safe.maxStdoutBytes) || safe.maxStdoutBytes < 1 ||
    typeof safe.maxStderrBytes !== "number" || !Number.isSafeInteger(safe.maxStderrBytes) || safe.maxStderrBytes < 1
  ) {
    return fail("Private KiCad runtime metadata envelope is invalid.");
  }
  const preimage = runtimeMetadataPreimage({
    schemaVersion: PRIVATE_RUNTIME_METADATA_SCHEMA,
    disposition: "detached-private-runtime-metadata",
    commandKind,
    command: safe.command,
    argv,
    cwd: safe.cwd,
    environment,
    expectedOutputs,
    acceptedExitCodes,
    timeoutMs: safe.timeoutMs,
    maxStdoutBytes: safe.maxStdoutBytes,
    maxStderrBytes: safe.maxStderrBytes,
    nativeProcessPlanIdentity,
    commandPlanIdentity,
    invocationInputSourceIdentity,
  });
  const metadataIdentity = validateCanonicalIdentity(safe.metadataIdentity, "$runtimeMetadata/metadataIdentity");
  if (
    metadataIdentity.schemaVersion !== PRIVATE_RUNTIME_METADATA_SCHEMA ||
    !same(metadataIdentity, portableCanonicalIdentity(preimage, PRIVATE_RUNTIME_METADATA_SCHEMA))
  ) {
    return fail("Private KiCad runtime metadata identity does not reproduce its preimage.");
  }
  return hardenPortableValue({ ...preimage, metadataIdentity }) as unknown as PrivateKicadRuntimeMetadataV3;
};

const emptyStable = (): StableBytes => Object.freeze({
  bytes: Buffer.alloc(0),
  identity: portableContentIdentity(Buffer.alloc(0)),
});

const completedAt = (now: () => string, pending: ToolInvocationRecord): string => {
  const value = now();
  if (!exactTimestamp(value) || value < pending.startedAt) {
    return fail("Portable KiCad producer clock did not provide a canonical completion instant.");
  }
  return value;
};

const completeInvocation = (
  pending: ToolInvocationRecord,
  outcome: Exclude<ToolInvocationRecord["outcome"], "unknown">,
  exitCode: number | null,
  stdout: StableBytes,
  stderr: StableBytes,
  now: () => string,
): ToolInvocationRecord => {
  const completed = completeToolInvocationRecord(pending, {
    outcome,
    stdoutIdentity: stdout.identity,
    stderrIdentity: stderr.identity,
    exitCode,
    completedAt: completedAt(now, pending),
  });
  const parsed = toolInvocationRecordSchema.safeParse(completed);
  if (!parsed.success) return fail("Completed W08 invocation record did not revalidate.");
  const terminal = parsed.data as ToolInvocationRecord;
  if (
    terminal.invocationIdentity === null ||
    terminal.portableReceiptInvocationIdentityV1 === null ||
    !same(terminal.invocationIdentity, toolInvocationIdentityV2(terminal)) ||
    !same(
      terminal.portableReceiptInvocationIdentityV1,
      portableReceiptInvocationIdentityV1(terminal),
    )
  ) {
    return fail("Completed W08 invocation identities do not reproduce their projections.");
  }
  return hardenPortableValue(terminal) as unknown as ToolInvocationRecord;
};

const captureProcessStreams = (
  result: BoundedProcessResult | BoundedProcessError | undefined,
): { readonly stdout: StableBytes; readonly stderr: StableBytes } => {
  const stdoutBytes = Buffer.from(result?.stdout ?? "", "utf8");
  const stderrBytes = Buffer.from(result?.stderr ?? "", "utf8");
  return Object.freeze({
    stdout: Object.freeze({ bytes: stdoutBytes, identity: portableContentIdentity(stdoutBytes) }),
    stderr: Object.freeze({ bytes: stderrBytes, identity: portableContentIdentity(stderrBytes) }),
  });
};

interface PrivateResolutionSnapshotV3 {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly expectedOutputs: readonly { readonly path: string; readonly maxBytes: number }[];
  readonly acceptedExitCodes: readonly number[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly nativeProcessPlanIdentity: CanonicalIdentity;
  readonly commandPlanIdentity: CanonicalIdentity;
  readonly invocationInputSourceIdentity: ContentIdentity;
}

const snapshotArray = <Value>(
  value: unknown,
  label: string,
  project: (entry: unknown, index: number) => Value,
): readonly Value[] => {
  if (!Array.isArray(value) || isProxy(value) || value.length > 256) {
    return fail(`${label} must be a bounded non-proxy array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.from({ length: value.length }, (_, index) => String(index)).some((key) => {
    const descriptor = descriptors[key];
    return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
  })) {
    return fail(`${label} must be dense and contain only data elements.`);
  }
  return Object.freeze(value.map((entry, index) => project(entry, index)));
};

const snapshotStringArray = (value: unknown, label: string): readonly string[] =>
  snapshotArray(value, label, (entry) =>
    typeof entry === "string" ? entry : fail(`${label} contains a non-string value.`));

const snapshotIntegerArray = (value: unknown, label: string): readonly number[] =>
  snapshotArray(value, label, (entry) =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0
      ? entry
      : fail(`${label} contains an invalid integer.`));

const snapshotEnvironment = (value: unknown): Readonly<Record<string, string>> => {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return fail("Private KiCad environment must be a plain non-proxy object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > 64 ||
    keys.some((key) => typeof key !== "string" || !/^[A-Z_][A-Z0-9_]{0,63}$/u.test(key)) ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) ||
        typeof descriptor.value !== "string" || !descriptor.enumerable;
    })
  ) {
    return fail("Private KiCad environment contains invalid or active properties.");
  }
  return Object.freeze(Object.fromEntries(
    (keys as string[]).sort().map((key) => [key, descriptors[key]!.value as string]),
  ));
};

const snapshotResolution = (
  resolution: ResolvedPrivateKicadInvocationV2,
): PrivateResolutionSnapshotV3 => {
  const argv = snapshotStringArray(resolution.argv, "Private KiCad argv");
  const expectedOutputPaths = snapshotStringArray(
    resolution.expectedOutputPaths,
    "Private KiCad output paths",
  );
  const expectedOutputs = snapshotArray(
    resolution.expectedOutputs,
    "Private KiCad expected outputs",
    (entry, index) => {
      const safe = exactRecord(entry, ["path", "maxBytes"], `Private KiCad expected output ${index}`);
      if (
        typeof safe.path !== "string" || !path.isAbsolute(safe.path) ||
        typeof safe.maxBytes !== "number" || !Number.isSafeInteger(safe.maxBytes) || safe.maxBytes < 1
      ) {
        return fail("Private KiCad expected output descriptor is invalid.");
      }
      return Object.freeze({ path: safe.path, maxBytes: safe.maxBytes });
    },
  );
  if (
    expectedOutputPaths.length !== expectedOutputs.length ||
    expectedOutputPaths.some((entry, index) => entry !== expectedOutputs[index]!.path)
  ) {
    return fail("Private KiCad output path projections disagree.");
  }
  return Object.freeze({
    commandKind: resolution.commandKind,
    command: String(resolution.command),
    argv,
    cwd: String(resolution.cwd),
    environment: snapshotEnvironment(resolution.environment),
    expectedOutputs,
    acceptedExitCodes: snapshotIntegerArray(resolution.acceptedExitCodes, "Private KiCad exit codes"),
    timeoutMs: resolution.timeoutMs,
    maxStdoutBytes: resolution.maxStdoutBytes,
    maxStderrBytes: resolution.maxStderrBytes,
    nativeProcessPlanIdentity: validateCanonicalIdentity(resolution.nativeProcessPlanIdentity),
    commandPlanIdentity: validateCanonicalIdentity(resolution.commandPlanIdentity),
    invocationInputSourceIdentity: validateContentIdentity(resolution.invocationInputSourceIdentity),
  });
};

const validatePrivateOperation = (
  operationValue: PrivatePortableKicadExecutionOperationV3,
  request: KicadBackendRequestV3,
): {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly binding: KicadPortableOperationRequestBindingV3;
  readonly plan: NativeProcessPlanV2;
  readonly pending: ToolInvocationRecord;
  readonly resolution: PrivateResolutionSnapshotV3;
} => {
  const operationRecord = exactRecord(operationValue, [
    "commandKind", "nativeProcessPlan", "pendingInvocation", "resolution",
  ], "Private KiCad v3 operation");
  const operation = operationRecord as unknown as PrivatePortableKicadExecutionOperationV3;
  const matchingBindings = request.operationBindings.filter(
    (binding) => binding.commandKind === operation.commandKind,
  );
  if (matchingBindings.length !== 1) return fail("Private operation has no unique public request binding.");
  const binding = matchingBindings[0]!;
  const plan = assertApprovedPortableKicadNativeProcessPlanV2(operation.nativeProcessPlan);
  if (
    plan.profile.operation !== operation.commandKind ||
    plan.command.kind !== "portable_typed_command_v1" ||
    !same(plan.planIdentity, binding.nativeProcessPlanIdentity) ||
    !same(plan.command.value.commandPlanIdentity, binding.commandPlanIdentity)
  ) {
    return fail("Private operation does not match its approved public plan binding.");
  }
  const parsedPending = toolInvocationRecordSchema.safeParse(operation.pendingInvocation);
  if (!parsedPending.success) return fail("Private operation has an invalid W08 invocation draft.");
  const pending = parsedPending.data as ToolInvocationRecord;
  assertNewToolInvocationRecord(pending);
  const fenceBindings = pending.executionFence.nativeProcessPlanBindings ?? [];
  const matchingFenceBindings = fenceBindings.filter((candidate) =>
    candidate.profileDomain === "kicad" &&
    candidate.operation === operation.commandKind &&
    same(candidate.contractIdentity, plan.profile.contractIdentity) &&
    same(candidate.planIdentity, plan.planIdentity));
  if (
    pending.id !== binding.invocationId ||
    pending.stage !== request.stage ||
    pending.projectId !== request.executionContext.projectId ||
    pending.runId !== request.executionContext.runId ||
    pending.attemptId !== request.executionContext.attemptId ||
    pending.fencingEpoch !== request.executionContext.fencingEpoch ||
    !same(pending.inputManifest, request.executionContext.inputManifest) ||
    !same(
      portableCanonicalIdentity(pending.executionFence, "evleda.stage-execution-fence.v1"),
      request.executionContext.executionFenceIdentity,
    ) ||
    !same(pending.commandPlan, plan) ||
    !same(pending.commandPlanIdentity, plan.planIdentity) ||
    matchingFenceBindings.length !== 1
  ) {
    return fail("Private operation is not bound to its W08 plan, invocation, stage, and execution fence.");
  }
  const matchingFenceBinding = matchingFenceBindings[0]!;
  if (
    !same(matchingFenceBinding.portableReceiptPlanIdentityV1, binding.portableReceiptPlanIdentityV1) ||
    !same(projectNativeProcessPlanV2ToLegacyV1(plan).planIdentity, binding.portableReceiptPlanIdentityV1)
  ) {
    return fail("Private operation W08 compatibility plan projection is invalid.");
  }
  const resolution = operation.resolution;
  const resolutionKeys = Reflect.ownKeys(resolution);
  const expectedResolutionKeys = [
    "schemaVersion", "disposition", "commandKind", "acceptedExitCodes", "timeoutMs",
    "maxStdoutBytes", "maxStderrBytes", "nativeProcessPlanIdentity", "commandPlanIdentity",
    "invocationInputSourceIdentity", "command", "argv", "cwd", "environment",
    "expectedOutputPaths", "expectedOutputs",
  ];
  const descriptors = Object.getOwnPropertyDescriptors(resolution);
  if (
    Object.getPrototypeOf(resolution) !== null ||
    !Object.isFrozen(resolution) ||
    resolutionKeys.length !== expectedResolutionKeys.length ||
    resolutionKeys.some((key) => typeof key !== "string" || !expectedResolutionKeys.includes(key)) ||
    expectedResolutionKeys.some((key) => descriptors[key] === undefined || !("value" in descriptors[key]!)) ||
    resolution.schemaVersion !== "evleda.private-resolved-kicad-invocation.v2" ||
    resolution.disposition !== "private-runtime-only" ||
    resolution.commandKind !== operation.commandKind ||
    !same(resolution.nativeProcessPlanIdentity, plan.planIdentity) ||
    !same(resolution.commandPlanIdentity, plan.command.value.commandPlanIdentity) ||
    !same(resolution.acceptedExitCodes, plan.acceptedExitCodes) ||
    resolution.timeoutMs !== plan.timeoutMs ||
    resolution.maxStdoutBytes !== plan.maxStdoutBytes ||
    resolution.maxStderrBytes !== plan.maxStderrBytes ||
    resolution.expectedOutputPaths.length !== 1 ||
    resolution.expectedOutputs.length !== 1 ||
    Object.prototype.propertyIsEnumerable.call(resolution, "command") ||
    Object.prototype.propertyIsEnumerable.call(resolution, "argv") ||
    Object.prototype.propertyIsEnumerable.call(resolution, "cwd") ||
    Object.prototype.propertyIsEnumerable.call(resolution, "environment") ||
    Object.prototype.propertyIsEnumerable.call(resolution, "expectedOutputPaths") ||
    Object.prototype.propertyIsEnumerable.call(resolution, "expectedOutputs")
  ) {
    return fail("Private operation resolution does not match the approved S1A plan.");
  }
  const resolutionSnapshot = snapshotResolution(resolution);
  const privateSourcePath = resolutionSnapshot.argv.at(-1);
  const privateOutputPath = resolutionSnapshot.expectedOutputs[0]?.path;
  if (
    privateSourcePath === undefined ||
    privateOutputPath === undefined ||
    !path.isAbsolute(resolutionSnapshot.command) ||
    !path.isAbsolute(resolutionSnapshot.cwd) ||
    !path.isAbsolute(privateSourcePath) ||
    !path.isAbsolute(privateOutputPath) ||
    resolutionSnapshot.expectedOutputs[0]!.maxBytes !== plan.expectedOutputs[0]!.maxBytes ||
    path.resolve(resolutionSnapshot.cwd) !== path.resolve(path.dirname(privateSourcePath)) ||
    resolutionSnapshot.argv.length !== plan.command.value.argv.length ||
    plan.command.value.argv.some((argument, index) => {
      const resolved = resolutionSnapshot.argv[index];
      return argument.kind === "literal"
        ? resolved !== argument.value
        : argument.value.root === "run_private"
          ? resolved !== privateOutputPath
          : resolved !== privateSourcePath;
    })
  ) {
    return fail("Private operation host arguments do not reproduce the approved logical plan.");
  }
  return Object.freeze({
    commandKind: operation.commandKind,
    binding,
    plan,
    pending,
    resolution: resolutionSnapshot,
  });
};

const rejectionPreimage = (
  value: Omit<PrivateKicadRuntimeRejectionV2, "rejectionIdentity">,
): Omit<PrivateKicadRuntimeRejectionV2, "rejectionIdentity"> => value;

export const validatePrivateKicadRuntimeRejectionV2 = (
  value: unknown,
): PrivateKicadRuntimeRejectionV2 => {
  const safe = exactRecord(hardenPortableValue(value), [
    "schemaVersion", "authority", "commandKind", "failureClass",
    "nativeProcessPlanIdentity", "commandPlanIdentity", "runtimeBinding",
    "sourceContentIdentity", "rawContentIdentity", "stdoutIdentity", "stderrIdentity",
    "processOutcome", "exitCode", "publicSemantics", "rawBoundReceipt", "capturedAt",
    "timestampDisposition", "releaseAuthorized", "rejectionIdentity",
  ], "Private KiCad runtime rejection");
  const commandKind = asCommandKind(safe.commandKind, "Private rejection command kind");
  const failureClass = safe.failureClass as PrivateKicadRuntimeFailureClassV1;
  const allowedFailureClasses: readonly PrivateKicadRuntimeFailureClassV1[] = [
    "source_snapshot", "spawn", "timeout", "cancelled", "nonaccepted_exit",
    "output_limit", "output_missing", "runner_contract", "source_changed", "normalization",
  ];
  const processOutcome = safe.processOutcome as PrivateKicadRuntimeRejectionV2["processOutcome"];
  const expectedOutcome: Readonly<Record<PrivateKicadRuntimeFailureClassV1, PrivateKicadRuntimeRejectionV2["processOutcome"]>> = {
    source_snapshot: "error",
    spawn: "error",
    timeout: "timed_out",
    cancelled: "cancelled",
    nonaccepted_exit: "failed",
    output_limit: safe.exitCode === null ? "error" : "succeeded",
    output_missing: "succeeded",
    runner_contract: "error",
    source_changed: "succeeded",
    normalization: "succeeded",
  };
  const boundedExitCode = typeof safe.exitCode === "number" &&
    Number.isSafeInteger(safe.exitCode) && safe.exitCode >= 0 && safe.exitCode <= 0xffff_ffff;
  if (
    safe.schemaVersion !== REJECTION_SCHEMA ||
    safe.authority !== "private-runtime-consistency-only" ||
    !allowedFailureClasses.includes(failureClass) ||
    !["succeeded", "failed", "timed_out", "cancelled", "error"].includes(processOutcome) ||
    processOutcome !== expectedOutcome[failureClass] ||
    (processOutcome === "succeeded" && !boundedExitCode) ||
    (processOutcome === "failed" && !boundedExitCode) ||
    (["timed_out", "cancelled", "error"].includes(processOutcome) && safe.exitCode !== null) ||
    safe.publicSemantics !== null ||
    safe.rawBoundReceipt !== null ||
    typeof safe.capturedAt !== "string" ||
    !exactTimestamp(safe.capturedAt) ||
    safe.timestampDisposition !== "excluded-private" ||
    safe.releaseAuthorized !== false
  ) {
    return fail("Private KiCad runtime rejection has an invalid outcome or authority matrix.");
  }
  const nativeProcessPlanIdentity = validateCanonicalIdentity(safe.nativeProcessPlanIdentity, "$rejection/nativeProcessPlanIdentity");
  const commandPlanIdentity = validateCanonicalIdentity(safe.commandPlanIdentity, "$rejection/commandPlanIdentity");
  const runtimeBinding = validateStandaloneInvocationBinding(safe.runtimeBinding, commandKind);
  const rejectionIdentity = validateCanonicalIdentity(safe.rejectionIdentity, "$rejection/rejectionIdentity");
  if (
    nativeProcessPlanIdentity.schemaVersion !== "evleda.native-process-plan.v2" ||
    commandPlanIdentity.schemaVersion !== "evleda.typed-command-plan.v1" ||
    !same(nativeProcessPlanIdentity, runtimeBinding.nativeProcessPlanIdentity) ||
    !same(commandPlanIdentity, runtimeBinding.commandPlanIdentity) ||
    rejectionIdentity.schemaVersion !== REJECTION_SCHEMA
  ) {
    return fail("Private KiCad runtime rejection identity domain is invalid.");
  }
  const preimage = rejectionPreimage({
    schemaVersion: REJECTION_SCHEMA,
    authority: "private-runtime-consistency-only",
    commandKind,
    failureClass,
    nativeProcessPlanIdentity,
    commandPlanIdentity,
    runtimeBinding,
    sourceContentIdentity: safe.sourceContentIdentity === null
      ? null
      : validateContentIdentity(safe.sourceContentIdentity, "$rejection/sourceContentIdentity"),
    rawContentIdentity: safe.rawContentIdentity === null
      ? null
      : validateContentIdentity(safe.rawContentIdentity, "$rejection/rawContentIdentity"),
    stdoutIdentity: validateContentIdentity(safe.stdoutIdentity, "$rejection/stdoutIdentity"),
    stderrIdentity: validateContentIdentity(safe.stderrIdentity, "$rejection/stderrIdentity"),
    processOutcome,
    exitCode: safe.exitCode as number | null,
    publicSemantics: null,
    rawBoundReceipt: null,
    capturedAt: safe.capturedAt,
    timestampDisposition: "excluded-private",
    releaseAuthorized: false,
  });
  if (!same(rejectionIdentity, portableCanonicalIdentity(preimage, REJECTION_SCHEMA))) {
    return fail("Private KiCad runtime rejection identity does not reproduce its preimage.");
  }
  return Object.freeze({ ...preimage, rejectionIdentity });
};

const buildRejection = (input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly failureClass: PrivateKicadRuntimeFailureClassV1;
  readonly plan: NativeProcessPlanV2;
  readonly terminalInvocation: ToolInvocationRecord;
  readonly runtimeBinding: KicadPortableInvocationBindingV3;
  readonly source: StableBytes | null;
  readonly raw: StableBytes | null;
  readonly stdout: StableBytes;
  readonly stderr: StableBytes;
}): PrivateKicadRuntimeRejectionV2 => {
  if (
    input.terminalInvocation.invocationIdentity === null ||
    input.terminalInvocation.portableReceiptInvocationIdentityV1 === null ||
    input.terminalInvocation.completedAt === null
  ) {
    return fail("Private rejection requires a terminal W08 invocation identity.");
  }
  const preimage = rejectionPreimage({
    schemaVersion: REJECTION_SCHEMA,
    authority: "private-runtime-consistency-only",
    commandKind: input.commandKind,
    failureClass: input.failureClass,
    nativeProcessPlanIdentity: input.plan.planIdentity,
    commandPlanIdentity: input.plan.command.kind === "portable_typed_command_v1"
      ? input.plan.command.value.commandPlanIdentity
      : fail("Portable KiCad rejection requires a typed command plan."),
    runtimeBinding: input.runtimeBinding,
    sourceContentIdentity: input.source?.identity ?? null,
    rawContentIdentity: input.raw?.identity ?? null,
    stdoutIdentity: input.stdout.identity,
    stderrIdentity: input.stderr.identity,
    processOutcome: input.terminalInvocation.outcome as Exclude<ToolInvocationRecord["outcome"], "unknown">,
    exitCode: input.terminalInvocation.exitCode,
    publicSemantics: null,
    rawBoundReceipt: null,
    capturedAt: input.terminalInvocation.completedAt,
    timestampDisposition: "excluded-private",
    releaseAuthorized: false,
  });
  return validatePrivateKicadRuntimeRejectionV2({
    ...preimage,
    rejectionIdentity: portableCanonicalIdentity(preimage, REJECTION_SCHEMA),
  });
};

const publicRejectedOperation = (
  commandKind: PortableKicadCommandKindV1,
  plan: NativeProcessPlanV2,
  terminalInvocation: ToolInvocationRecord,
  rejection: PrivateKicadRuntimeRejectionV2,
  runtimeBinding: KicadPortableInvocationBindingV3,
): KicadPortableOperationResultV3 => {
  if (plan.command.kind !== "portable_typed_command_v1" || terminalInvocation.invocationIdentity === null) {
    return fail("Rejected operation lacks terminal identity bindings.");
  }
  return Object.freeze({
    schemaVersion: OPERATION_RESULT_SCHEMA,
    commandKind,
    status: "private_runtime_rejected",
    nativeProcessPlanIdentity: plan.planIdentity,
    commandPlanIdentity: plan.command.value.commandPlanIdentity,
    runtimeBinding,
    privateRejectionIdentity: rejection.rejectionIdentity,
    semantics: null,
    rawBoundReceipt: null,
    hostAuthenticated: false,
    manufactureReady: false,
    releaseAuthorized: false,
  });
};

const normalize = (
  kind: PortableReportKind,
  rawBytes: Uint8Array,
  bindings: PortableNormalizationBindingsV2,
): PortableNormalizationResultV2 => {
  switch (kind) {
    case "kicad_erc": return normalizeKiCadErc(rawBytes, bindings);
    case "kicad_drc": return normalizeKiCadDrc(rawBytes, bindings);
    case "kicad_netlist": return normalizeKiCadNetlist(rawBytes, bindings);
    case "kicad_stats": return normalizeKiCadStats(rawBytes, bindings);
    case "kicad_d356": return normalizeKiCadD356(rawBytes, bindings);
  }
};

const canonicalBytes = (value: unknown): Buffer =>
  Buffer.from(`${canonicalPortableJson(value)}\n`, "utf8");

const buildPrivateCapture = (input: {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly source: StableBytes;
  readonly invocationInputSource: StableBytes;
  readonly raw: StableBytes;
  readonly stdout: StableBytes;
  readonly stderr: StableBytes;
  readonly terminalInvocation: ToolInvocationRecord;
  readonly runtimeMetadata: PrivateKicadRuntimeMetadataV3;
  readonly privateReceipt: PrivateRawCaptureReceiptV2;
  readonly compoundVerification: PortableCompoundVerificationV2 | PortablePdfCompoundVerificationV2;
}): DetachedPrivateKicadCaptureDraftV3 => {
  if (
    input.terminalInvocation.invocationIdentity === null ||
    input.terminalInvocation.portableReceiptInvocationIdentityV1 === null
  ) {
    return fail("Private capture requires a terminal W08 identity.");
  }
  const privateReceiptBytes = canonicalBytes(input.privateReceipt);
  const fullResult = withPrivateKicadFullResultIdentity({
    schemaVersion: "evleda.private-kicad-full-result.v1",
    authority: "private-storage-consistency-only",
    reportKind: input.commandKind,
    rawContentIdentity: input.raw.identity,
    sourceContentIdentity: input.source.identity,
    stdoutIdentity: input.stdout.identity,
    stderrIdentity: input.stderr.identity,
    commandPlanIdentity: input.privateReceipt.commandPlanIdentity,
    invocationIdentity: input.terminalInvocation.portableReceiptInvocationIdentityV1,
    captureIdentity: input.privateReceipt.captureIdentity,
    privateReceiptContentIdentity: portableContentIdentity(privateReceiptBytes),
    privateReceiptRecordIdentity: input.privateReceipt.receiptIdentity,
    outcome: input.privateReceipt.outcome,
    exitCode: input.privateReceipt.exitCode,
    releaseAuthorized: false,
  });
  const files: PrivateKicadCaptureFiles = Object.freeze({
    raw: Buffer.from(input.raw.bytes),
    source: Buffer.from(input.source.bytes),
    stdout: Buffer.from(input.stdout.bytes),
    stderr: Buffer.from(input.stderr.bytes),
    fullResult: canonicalBytes(fullResult),
    privateReceipt: privateReceiptBytes,
  });
  return Object.freeze({
    disposition: "detached-private-capture-draft",
    commandKind: input.commandKind,
    files,
    invocationInputSourceBytes: Buffer.from(input.invocationInputSource.bytes),
    privateReceipt: input.privateReceipt,
    fullResult,
    terminalInvocation: hardenPortableValue(input.terminalInvocation) as unknown as ToolInvocationRecord,
    runtimeMetadata: validatePrivateKicadRuntimeMetadataV3(input.runtimeMetadata),
    compoundVerification: input.compoundVerification,
  });
};

const tryCaptureOutput = async (
  reservation: FreshOutputReservation,
): Promise<StableBytes | null> => {
  try {
    return await captureStableFile(
      reservation.path,
      reservation.maxBytes,
      "KiCad private output",
      reservation,
    );
  } catch {
    return null;
  }
};

interface OperationExecutionResult {
  readonly publicResult: KicadPortableOperationResultV3;
  readonly privateDraft: DetachedPrivateKicadOperationDraftV3;
}

interface PreparedPrivateOperationV3 {
  readonly commandKind: PortableKicadCommandKindV1;
  readonly binding: KicadPortableOperationRequestBindingV3;
  readonly plan: NativeProcessPlanV2;
  readonly pending: ToolInvocationRecord;
  readonly resolution: PrivateResolutionSnapshotV3;
  readonly sourceBefore: StableFileSnapshot;
  readonly reservation: FreshOutputReservation;
  readonly runtimeMetadata: PrivateKicadRuntimeMetadataV3;
}

const rejectedExecution = (input: {
  readonly prepared: PreparedPrivateOperationV3;
  readonly request: KicadBackendRequestV3;
  readonly failureClass: PrivateKicadRuntimeFailureClassV1;
  readonly terminal: ToolInvocationRecord;
  readonly source: StableBytes | null;
  readonly raw: StableBytes | null;
  readonly stdout: StableBytes;
  readonly stderr: StableBytes;
}): OperationExecutionResult => {
  const runtimeBinding = buildInvocationBinding(
    input.terminal,
    input.prepared.binding,
    input.request.executionContext,
  );
  const rejection = buildRejection({
    commandKind: input.prepared.commandKind,
    failureClass: input.failureClass,
    plan: input.prepared.plan,
    terminalInvocation: input.terminal,
    runtimeBinding,
    source: input.source,
    raw: input.raw,
    stdout: input.stdout,
    stderr: input.stderr,
  });
  return Object.freeze({
    publicResult: publicRejectedOperation(
      input.prepared.commandKind,
      input.prepared.plan,
      input.terminal,
      rejection,
      runtimeBinding,
    ),
    privateDraft: Object.freeze({
      disposition: "detached-private-rejection-draft",
      commandKind: input.prepared.commandKind,
      rejection,
      sourceBytes: Buffer.from(input.source?.bytes ?? Buffer.alloc(0)),
      invocationInputSourceBytes: Buffer.from(input.prepared.sourceBefore.bytes),
      rawBytes: Buffer.from(input.raw?.bytes ?? Buffer.alloc(0)),
      stdoutBytes: Buffer.from(input.stdout.bytes),
      stderrBytes: Buffer.from(input.stderr.bytes),
      terminalInvocation: hardenPortableValue(input.terminal) as unknown as ToolInvocationRecord,
      runtimeMetadata: validatePrivateKicadRuntimeMetadataV3(input.prepared.runtimeMetadata),
    }),
  });
};

const executeOne = async (
  prepared: PreparedPrivateOperationV3,
  request: KicadBackendRequestV3,
  normalizer: ToolContentIdentityV1,
  runner: BoundedProcessRunner,
  now: () => string,
): Promise<OperationExecutionResult> => {
  const { commandKind, plan, pending, resolution, sourceBefore, reservation, runtimeMetadata } = prepared;
  if (plan.command.kind !== "portable_typed_command_v1") {
    return fail("Approved KiCad plan did not retain its typed command variant.");
  }
  const sourcePath = resolution.argv.at(-1);
  const outputPath = reservation.path;
  const outputLimit = reservation.maxBytes;
  if (
    sourcePath === undefined ||
    outputPath === undefined ||
    outputLimit === undefined ||
    resolution.argv.at(-2) !== outputPath ||
    resolution.acceptedExitCodes.some((code, index) => code !== plan.acceptedExitCodes[index]) ||
    resolution.acceptedExitCodes.length !== plan.acceptedExitCodes.length
  ) {
    return fail("Private KiCad resolution lost its source, output, or exit policy binding.");
  }

  let processResult: BoundedProcessResult;
  try {
    processResult = await runner({
      command: resolution.command,
      args: resolution.argv,
      cwd: resolution.cwd,
      env: resolution.environment,
      timeoutMs: resolution.timeoutMs,
      maxOutputBytes: Math.min(resolution.maxStdoutBytes, resolution.maxStderrBytes),
    });
  } catch (error) {
    const bounded = error instanceof BoundedProcessError ? error : undefined;
    const streams = captureProcessStreams(bounded);
    const outcome = error instanceof ProcessTimeoutError
      ? "timed_out" as const
      : error instanceof ProcessAbortError
        ? "cancelled" as const
        : "error" as const;
    const failureClass = error instanceof ProcessTimeoutError
      ? "timeout" as const
      : error instanceof ProcessAbortError
        ? "cancelled" as const
        : error instanceof ProcessOutputLimitError
          ? "output_limit" as const
          : "spawn" as const;
    const terminal = completeInvocation(pending, outcome, null, streams.stdout, streams.stderr, now);
    const raw = await tryCaptureOutput(reservation);
    return rejectedExecution({
      prepared,
      request,
      failureClass,
      terminal,
      source: sourceBefore,
      raw,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
  }

  const streams = captureProcessStreams(processResult);
  const echoMatches =
    processResult.command === resolution.command &&
    same(processResult.args, resolution.argv) &&
    processResult.cwd === resolution.cwd;
  if (!echoMatches) {
    const terminal = completeInvocation(pending, "error", null, streams.stdout, streams.stderr, now);
    const raw = await tryCaptureOutput(reservation);
    return rejectedExecution({
      prepared,
      request,
      failureClass: "runner_contract",
      terminal,
      source: sourceBefore,
      raw,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
  }
  const accepted = resolution.acceptedExitCodes.includes(processResult.exitCode);
  const terminal = completeInvocation(
    pending,
    accepted ? "succeeded" : "failed",
    processResult.exitCode,
    streams.stdout,
    streams.stderr,
    now,
  );
  if (!accepted) {
    const raw = await tryCaptureOutput(reservation);
    return rejectedExecution({
      prepared,
      request,
      failureClass: "nonaccepted_exit",
      terminal,
      source: sourceBefore,
      raw,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
  }

  let source: StableBytes;
  try {
    source = await captureStableFile(sourcePath, MAX_NATIVE_ARTIFACT_BYTES, "evaluated KiCad source snapshot");
  } catch {
    const changedRaw = await tryCaptureOutput(reservation);
    return rejectedExecution({
      prepared,
      request,
      failureClass: "source_changed",
      terminal,
      source: sourceBefore,
      raw: changedRaw,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
  }
  if (commandKind !== "kicad_drc" && !same(source.identity, sourceBefore.identity)) {
    const changedRaw = await tryCaptureOutput(reservation);
    return rejectedExecution({
      prepared,
      request,
      failureClass: "source_changed",
      terminal,
      source,
      raw: changedRaw,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
  }

  let raw: StableBytes;
  try {
    raw = await captureStableFile(
      outputPath,
      outputLimit,
      "KiCad private output",
      reservation,
    );
  } catch (error) {
    const outputLimit = error instanceof PortableKicadProducerV3Error &&
      error.details.fileCaptureFailure === "limit";
    return rejectedExecution({
      prepared,
      request,
      failureClass: outputLimit ? "output_limit" : "output_missing",
      terminal,
      source,
      raw: null,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
  }

  const d356Profile = commandKind === "kicad_d356"
    ? REVIEWED_KICAD_D356_REV_A_PROFILE_V1
    : undefined;
  try {
    const logicalSourceArgument = plan.command.value.argv.at(-1);
    if (logicalSourceArgument?.kind !== "path") {
      return fail("Approved KiCad plan lacks its source path.");
    }
    const sourceIdentitySet = buildPortableKicadSourceIdentitySetV1({
      commandKind,
      sourcePath: logicalSourceArgument.value,
      sourceBytes: source.bytes,
      ...(d356Profile === undefined ? {} : { d356Profile }),
    });
    const nativeContract = buildPortableKicadNativeContractV2({
      commandKind,
      nativeProcessPlan: plan,
      sourceIdentitySet,
      invocationInputSourceIdentity: sourceBefore.identity,
      ...(d356Profile === undefined ? {} : { d356Profile }),
    });
    const normalizerContract = buildPortableKicadNormalizerContractV2({
      commandKind,
      normalizer,
      ...(d356Profile === undefined ? {} : { d356Profile }),
    });
    if (
      terminal.invocationIdentity === null ||
      terminal.portableReceiptInvocationIdentityV1 === null ||
      terminal.completedAt === null
    ) {
      return fail("Successful KiCad process lacks a terminal W08 identity.");
    }
    const runtimeBinding = buildInvocationBinding(
      terminal,
      prepared.binding,
      request.executionContext,
    );
    const sourceRelation = buildSourceRelation(commandKind, sourceBefore.identity, source.identity);
    const commonReceipt = {
      schemaVersion: "evleda.private-raw-capture-receipt.v2" as const,
      authority: "private-non-authoritative" as const,
      reportKind: commandKind,
      sourceBinding: sourceIdentitySet.sourceBinding,
      rawContentIdentity: raw.identity,
      privateRawPath: plan.command.value.expectedOutputs[0]!,
      nativeContractIdentity: nativeContract.identity,
      normalizerContractIdentity: normalizerContract.identity,
      toolIdentity: plan.command.value.tool,
      commandPlanIdentity: plan.command.value.commandPlanIdentity,
      invocationIdentity: terminal.portableReceiptInvocationIdentityV1,
      stdoutIdentity: streams.stdout.identity,
      stderrIdentity: streams.stderr.identity,
      exitCode: processResult.exitCode,
      capturedAt: terminal.completedAt,
      timestampDisposition: "excluded-private" as const,
    };

    if (commandKind === "kicad_pdf") {
      const marker = normalizeKiCadPdfV2(raw.bytes);
      const privateReceipt = withPrivateRawCaptureReceiptV2Identities({
        ...commonReceipt,
        outcome: "succeeded",
        publicSemanticIdentity: null,
      });
      const compoundVerification = verifyPortablePdfCompoundV2({
        rawBytes: raw.bytes,
        sourceBytes: source.bytes,
        sourceBinding: sourceIdentitySet.sourceBinding,
        nativeContractIdentity: nativeContract.identity,
        normalizerContractIdentity: normalizerContract.identity,
        commandPlan: plan.command.value,
        nativeOutcome: {
          schemaVersion: "evleda.pdf-native-command-outcome.v1",
          invocationIdentity: terminal.portableReceiptInvocationIdentityV1,
          outcome: "succeeded",
          exitCode: processResult.exitCode,
          accepted: true,
          complete: true,
        },
        expectedMarker: marker,
        privateReceipt,
      });
      const publicResult = Object.freeze({
        schemaVersion: OPERATION_RESULT_SCHEMA,
        commandKind: "kicad_pdf" as const,
        status: "private_pdf_not_run_publicly" as const,
        sourceBinding: sourceIdentitySet.sourceBinding,
        sourceRelation,
        nativeContractIdentity: nativeContract.identity,
        normalizerContractIdentity: normalizerContract.identity,
        nativeProcessPlanIdentity: plan.planIdentity,
        commandPlanIdentity: plan.command.value.commandPlanIdentity,
        runtimeBinding,
        marker,
        privateCaptureIdentity: privateReceipt.captureIdentity,
        compoundVerificationIdentity: compoundVerification.verificationIdentity,
        hostAuthenticated: false as const,
        manufactureReady: false as const,
        releaseAuthorized: false as const,
      });
      return Object.freeze({
        publicResult,
        privateDraft: buildPrivateCapture({
          commandKind,
          source,
          invocationInputSource: sourceBefore,
          raw,
          ...streams,
          terminalInvocation: terminal,
          runtimeMetadata,
          privateReceipt,
          compoundVerification,
        }),
      });
    }

    const bindings: PortableNormalizationBindingsV2 = Object.freeze({
      schemaVersion: "evleda.portable-normalization-bindings.v2",
      sourceBinding: sourceIdentitySet.sourceBinding,
      nativeContractIdentity: nativeContract.identity,
      normalizerContractIdentity: normalizerContract.identity,
      normalizer,
      commandPlan: plan.command.value,
      nativeOutcome: {
        schemaVersion: "evleda.native-command-outcome.v1" as const,
        invocationIdentity: terminal.portableReceiptInvocationIdentityV1,
        outcome: "succeeded" as const,
        exitCode: processResult.exitCode as 0 | 5,
        accepted: true as const,
        complete: true as const,
      },
    });
    const normalized = validatePortableNormalizationResultV2(
      normalize(commandKind, raw.bytes, bindings),
    );
    const privateReceipt = withPrivateRawCaptureReceiptV2Identities({
      ...commonReceipt,
      outcome: "succeeded",
      publicSemanticIdentity: normalized.semantics.semanticIdentity,
    });
    const compoundVerification = verifyPortableNormalizationCompoundV2({
      reportKind: commandKind,
      rawBytes: raw.bytes,
      sourceBytes: source.bytes,
      bindings,
      expectedResult: normalized,
      privateReceipt,
    });
    const publicResult = Object.freeze({
      schemaVersion: OPERATION_RESULT_SCHEMA,
      commandKind,
      status: "portable_semantics_created" as const,
      sourceBinding: sourceIdentitySet.sourceBinding,
      sourceRelation,
      nativeContractIdentity: nativeContract.identity,
      normalizerContractIdentity: normalizerContract.identity,
      nativeProcessPlanIdentity: plan.planIdentity,
      commandPlanIdentity: plan.command.value.commandPlanIdentity,
      runtimeBinding,
      semantics: normalized.semantics,
      rawBoundReceipt: normalized.rawBoundReceipt,
      captureEnvelopeIdentity: normalized.captureEnvelope.captureIdentity,
      privateCaptureIdentity: privateReceipt.captureIdentity,
      compoundVerificationIdentity: compoundVerification.verificationIdentity,
      hostAuthenticated: false as const,
      manufactureReady: false as const,
      releaseAuthorized: false as const,
    });
    return Object.freeze({
      publicResult,
      privateDraft: buildPrivateCapture({
        commandKind,
        source,
        invocationInputSource: sourceBefore,
        raw,
        ...streams,
        terminalInvocation: terminal,
        runtimeMetadata,
        privateReceipt,
        compoundVerification,
      }),
    });
  } catch {
    return rejectedExecution({
      prepared,
      request,
      failureClass: "normalization",
      terminal,
      source,
      raw,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
  }
};

type ValidatedPrivateOperationV3 = ReturnType<typeof validatePrivateOperation>;

const normalizedHostPath = (value: string): string =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

const assertOneSourceFamily = (
  prepared: readonly { readonly commandKind: PortableKicadCommandKindV1; readonly sourceBefore: StableFileSnapshot }[],
  kinds: readonly PortableKicadCommandKindV1[],
  label: string,
): void => {
  const family = prepared.filter((entry) => kinds.includes(entry.commandKind));
  if (
    family.length > 1 &&
    family.some((entry) => !same(entry.sourceBefore.identity, family[0]!.sourceBefore.identity))
  ) {
    fail(`KiCad v3 ${label} operations do not share one exact source revision.`);
  }
};

const prepareAllOperations = async (
  validated: readonly ValidatedPrivateOperationV3[],
): Promise<readonly PreparedPrivateOperationV3[]> => {
  const paths = validated.map((entry) => {
    const sourcePath = entry.resolution.argv.at(-1);
    const output = entry.resolution.expectedOutputs[0];
    if (sourcePath === undefined || output === undefined) {
      return fail("KiCad v3 preflight lost a source or output path.");
    }
    return Object.freeze({ entry, sourcePath, output });
  });
  const sourcePathKeys = paths.map((entry) => normalizedHostPath(entry.sourcePath));
  const outputPathKeys = paths.map((entry) => normalizedHostPath(entry.output.path));
  if (
    new Set(sourcePathKeys).size !== sourcePathKeys.length ||
    new Set(outputPathKeys).size !== outputPathKeys.length ||
    sourcePathKeys.some((entry) => outputPathKeys.includes(entry))
  ) {
    return fail("KiCad v3 operations require disjoint per-command source and output paths.");
  }
  const sourceSnapshots = await Promise.all(paths.map(async ({ entry, sourcePath }) => {
    const sourceBefore = await captureStableFile(
      sourcePath,
      MAX_NATIVE_ARTIFACT_BYTES,
      "KiCad command source snapshot",
    );
    if (!same(sourceBefore.identity, entry.resolution.invocationInputSourceIdentity)) {
      return fail("KiCad command source changed after private resolution.");
    }
    if (
      entry.commandKind === "kicad_d356" &&
      !same(sourceBefore.identity, REVIEWED_KICAD_D356_REV_A_PROFILE_V1.exactBoardContentIdentity)
    ) {
      return fail("Portable D356 execution is confined to the exact reviewed Rev-A board.");
    }
    return Object.freeze({ ...entry, sourceBefore });
  }));
  assertOneSourceFamily(
    sourceSnapshots,
    ["kicad_erc", "kicad_netlist", "kicad_pdf"],
    "schematic-source",
  );
  assertOneSourceFamily(
    sourceSnapshots,
    ["kicad_drc", "kicad_stats", "kicad_d356"],
    "PCB-source",
  );

  const reservations: FreshOutputReservation[] = [];
  try {
    const prepared: PreparedPrivateOperationV3[] = [];
    for (const entry of sourceSnapshots) {
      const expectedOutput = entry.resolution.expectedOutputs[0]!;
      if (
        expectedOutput.maxBytes !== PORTABLE_KICAD_OUTPUT_BYTE_CEILINGS_V1.limits[entry.commandKind]
      ) {
        return fail("KiCad v3 output ceiling disagrees with the approved operation profile.");
      }
      const reservation = await reserveFreshOutput(expectedOutput);
      reservations.push(reservation);
      const runtimeMetadata = validatePrivateKicadRuntimeMetadataV3(
        buildPrivateRuntimeMetadata(entry.resolution, reservation),
      );
      prepared.push(Object.freeze({ ...entry, reservation, runtimeMetadata }));
    }
    return Object.freeze(prepared);
  } catch (error) {
    await rollbackFreshReservations(reservations);
    throw error;
  }
};

const detachedBytes = (
  value: unknown,
  maximumBytes: number,
  allowEmpty: boolean,
): StableBytes => {
  const snapshot = capturePortableRawBytes(
    value as Uint8Array,
    maximumBytes,
    allowEmpty,
  );
  const bytes = Buffer.alloc(snapshot.byteLength);
  if (snapshot.byteLength > 0) {
    const branded = value as Uint8Array;
    bytes.set(branded);
  }
  if (!same(portableContentIdentity(bytes), snapshot.identity)) {
    return fail("Detached private bytes changed during independent consumption.");
  }
  return Object.freeze({ bytes, identity: snapshot.identity });
};

const verifiedTerminalInvocation = (value: unknown): ToolInvocationRecord => {
  const parsed = toolInvocationRecordSchema.safeParse(value);
  if (!parsed.success) return fail("Detached private draft has an invalid W08 terminal record.");
  const terminal = parsed.data as ToolInvocationRecord;
  if (
    terminal.outcome === "unknown" ||
    terminal.invocationIdentity === null ||
    terminal.portableReceiptInvocationIdentityV1 === null ||
    !same(terminal.invocationIdentity, toolInvocationIdentityV2(terminal)) ||
    !same(
      terminal.portableReceiptInvocationIdentityV1,
      portableReceiptInvocationIdentityV1(terminal),
    )
  ) {
    return fail("Detached W08 terminal identities do not reproduce their current and compatibility records.");
  }
  return hardenPortableValue(terminal) as unknown as ToolInvocationRecord;
};

const assertRuntimeBindingTerminal = (
  binding: KicadPortableInvocationBindingV3,
  terminal: ToolInvocationRecord,
  metadata: PrivateKicadRuntimeMetadataV3,
): void => {
  if (
    terminal.invocationIdentity === null ||
    terminal.portableReceiptInvocationIdentityV1 === null ||
    terminal.id !== binding.invocationId ||
    !same(terminal.invocationIdentity, binding.authoritativeInvocationIdentityV2) ||
    !same(
      terminal.portableReceiptInvocationIdentityV1,
      binding.portableReceiptInvocationIdentityV1,
    ) ||
    !same(terminal.commandPlanIdentity, binding.nativeProcessPlanIdentity) ||
    !same(
      projectNativeProcessPlanV2ToLegacyV1(terminal.commandPlan).planIdentity,
      binding.portableReceiptPlanIdentityV1,
    ) ||
    !same(metadata.nativeProcessPlanIdentity, binding.nativeProcessPlanIdentity) ||
    !same(metadata.commandPlanIdentity, binding.commandPlanIdentity)
  ) {
    fail("Private terminal/runtime metadata does not reproduce the public invocation binding.");
  }
};

const consumeCaptureDraft = (
  publicOperation: KicadPortableOperationResultV3,
  draftValue: unknown,
  requestBinding: KicadPortableOperationRequestBindingV3,
  executionContext: KicadPortableExecutionContextV3,
): void => {
  const draft = exactRecord(draftValue, [
    "disposition", "commandKind", "files", "invocationInputSourceBytes",
    "privateReceipt", "fullResult", "terminalInvocation", "runtimeMetadata",
    "compoundVerification",
  ], "Detached private KiCad capture draft");
  if (
    draft.disposition !== "detached-private-capture-draft" ||
    draft.commandKind !== publicOperation.commandKind
  ) {
    fail("Detached private capture does not match its public operation.");
  }
  if (publicOperation.status === "private_runtime_rejected") {
    fail("A public rejection cannot consume a private capture draft.");
  }
  const capturedOperation = publicOperation as
    | KicadPortableOperationSuccessV3
    | KicadPortablePdfResultV3;
  const terminal = verifiedTerminalInvocation(draft.terminalInvocation);
  const runtimeMetadata = validatePrivateKicadRuntimeMetadataV3(draft.runtimeMetadata);
  const runtimeBinding = validateInvocationBinding(
    capturedOperation.runtimeBinding,
    requestBinding,
    executionContext,
  );
  assertRuntimeBindingTerminal(runtimeBinding, terminal, runtimeMetadata);
  const terminalCommand = terminal.commandPlan.command;
  if (terminalCommand.kind !== "portable_typed_command_v1") {
    fail("Detached KiCad terminal record lost its typed command plan.");
  }
  const typedCommand = terminalCommand.value as unknown as TypedCommandPlanV1;
  const fileRecord = exactRecord(draft.files, [
    "raw", "source", "stdout", "stderr", "fullResult", "privateReceipt",
  ], "Detached private KiCad files");
  const outputLimit = terminal.commandPlan.expectedOutputs[0]?.maxBytes ??
    fail("Detached KiCad terminal record lacks an output ceiling.");
  const raw = detachedBytes(fileRecord.raw, outputLimit, false);
  const source = detachedBytes(fileRecord.source, MAX_NATIVE_ARTIFACT_BYTES, false);
  const invocationInputSource = detachedBytes(
    draft.invocationInputSourceBytes,
    MAX_NATIVE_ARTIFACT_BYTES,
    false,
  );
  const stdout = detachedBytes(fileRecord.stdout, terminal.commandPlan.maxStdoutBytes, true);
  const stderr = detachedBytes(fileRecord.stderr, terminal.commandPlan.maxStderrBytes, true);
  const privateReceiptBytes = detachedBytes(fileRecord.privateReceipt, 65_536, false);
  const fullResultBytes = detachedBytes(fileRecord.fullResult, 65_536, false);
  const privateReceipt = parsePrivateRawCaptureReceiptV2Bytes(privateReceiptBytes.bytes);
  const fullResult = parseCanonicalPrivateKicadFullResultV1Bytes(fullResultBytes.bytes);
  const sourceRelation = validateSourceRelation(
    capturedOperation.sourceRelation,
    capturedOperation.commandKind,
    source.identity,
  );
  if (
    !same(privateReceipt, draft.privateReceipt) ||
    !same(fullResult, draft.fullResult) ||
    !same(invocationInputSource.identity, runtimeMetadata.invocationInputSourceIdentity) ||
    !same(invocationInputSource.identity, sourceRelation.invocationInputSourceIdentity) ||
    !same(source.identity, sourceRelation.evaluatedSourceIdentity) ||
    !same(raw.identity, privateReceipt.rawContentIdentity) ||
    !same(source.identity, privateReceipt.sourceBinding.sourceArtifactIdentity) ||
    !same(stdout.identity, privateReceipt.stdoutIdentity) ||
    !same(stderr.identity, privateReceipt.stderrIdentity) ||
    !same(terminal.portableReceiptInvocationIdentityV1, privateReceipt.invocationIdentity) ||
    !same(fullResult.rawContentIdentity, raw.identity) ||
    !same(fullResult.sourceContentIdentity, source.identity) ||
    !same(fullResult.stdoutIdentity, stdout.identity) ||
    !same(fullResult.stderrIdentity, stderr.identity) ||
    !same(fullResult.invocationIdentity, terminal.portableReceiptInvocationIdentityV1) ||
    !same(fullResult.captureIdentity, privateReceipt.captureIdentity) ||
    !same(fullResult.privateReceiptContentIdentity, privateReceiptBytes.identity) ||
    !same(fullResult.privateReceiptRecordIdentity, privateReceipt.receiptIdentity)
  ) {
    fail("Detached private capture bytes, receipt, full result, or W08 record disagree.");
  }

  if (capturedOperation.status === "private_pdf_not_run_publicly") {
    const verification = verifyPortablePdfCompoundV2({
      rawBytes: raw.bytes,
      sourceBytes: source.bytes,
      sourceBinding: capturedOperation.sourceBinding,
      nativeContractIdentity: capturedOperation.nativeContractIdentity,
      normalizerContractIdentity: capturedOperation.normalizerContractIdentity,
      commandPlan: typedCommand,
      nativeOutcome: {
        schemaVersion: "evleda.pdf-native-command-outcome.v1",
        invocationIdentity: terminal.portableReceiptInvocationIdentityV1!,
        outcome: "succeeded",
        exitCode: terminal.exitCode,
        accepted: true,
        complete: true,
      },
      expectedMarker: capturedOperation.marker,
      privateReceipt,
    });
    if (
      !same(verification, draft.compoundVerification) ||
      !same(verification.verificationIdentity, capturedOperation.compoundVerificationIdentity) ||
      !same(privateReceipt.captureIdentity, capturedOperation.privateCaptureIdentity)
    ) {
      fail("Detached PDF compound does not reproduce its public v3 result.");
    }
    return;
  }
  const semanticOperation = capturedOperation as KicadPortableOperationSuccessV3;

  const bindings: PortableNormalizationBindingsV2 = Object.freeze({
    schemaVersion: "evleda.portable-normalization-bindings.v2",
    sourceBinding: semanticOperation.sourceBinding,
    nativeContractIdentity: semanticOperation.nativeContractIdentity,
    normalizerContractIdentity: semanticOperation.normalizerContractIdentity,
    normalizer: semanticOperation.semantics.normalizer,
    commandPlan: typedCommand,
    nativeOutcome: {
      schemaVersion: "evleda.native-command-outcome.v1" as const,
      invocationIdentity: terminal.portableReceiptInvocationIdentityV1!,
      outcome: "succeeded" as const,
      exitCode: terminal.exitCode as 0 | 5,
      accepted: true as const,
      complete: true as const,
    },
  });
  const storedCompound = draft.compoundVerification as PortableCompoundVerificationV2;
  const verification = verifyPortableNormalizationCompoundV2({
    reportKind: semanticOperation.commandKind,
    rawBytes: raw.bytes,
    sourceBytes: source.bytes,
    bindings,
    expectedResult: storedCompound.result,
    privateReceipt,
  });
  if (
    !same(verification, storedCompound) ||
    !same(verification.verificationIdentity, semanticOperation.compoundVerificationIdentity) ||
    !same(verification.result.semantics, semanticOperation.semantics) ||
    !same(verification.result.rawBoundReceipt, semanticOperation.rawBoundReceipt) ||
    !same(verification.result.captureEnvelope.captureIdentity, semanticOperation.captureEnvelopeIdentity) ||
    !same(privateReceipt.captureIdentity, semanticOperation.privateCaptureIdentity)
  ) {
    fail("Detached normalization compound does not reproduce its public v3 result.");
  }
};

const consumeRejectionDraft = (
  publicOperation: KicadPortableOperationResultV3,
  draftValue: unknown,
  requestBinding: KicadPortableOperationRequestBindingV3,
  executionContext: KicadPortableExecutionContextV3,
): void => {
  const draft = exactRecord(draftValue, [
    "disposition", "commandKind", "rejection", "sourceBytes",
    "invocationInputSourceBytes", "rawBytes", "stdoutBytes", "stderrBytes",
    "terminalInvocation", "runtimeMetadata",
  ], "Detached private KiCad rejection draft");
  if (
    draft.disposition !== "detached-private-rejection-draft" ||
    draft.commandKind !== publicOperation.commandKind
  ) {
    fail("Detached private rejection does not match its public operation.");
  }
  if (publicOperation.status !== "private_runtime_rejected") {
    fail("A public capture cannot consume a private rejection draft.");
  }
  const rejectedOperation = publicOperation as KicadPortableRejectedOperationV3;
  const terminal = verifiedTerminalInvocation(draft.terminalInvocation);
  const runtimeMetadata = validatePrivateKicadRuntimeMetadataV3(draft.runtimeMetadata);
  const runtimeBinding = validateInvocationBinding(
    rejectedOperation.runtimeBinding,
    requestBinding,
    executionContext,
  );
  assertRuntimeBindingTerminal(runtimeBinding, terminal, runtimeMetadata);
  const rejection = validatePrivateKicadRuntimeRejectionV2(draft.rejection);
  const source = detachedBytes(draft.sourceBytes, MAX_NATIVE_ARTIFACT_BYTES, true);
  const invocationInputSource = detachedBytes(
    draft.invocationInputSourceBytes,
    MAX_NATIVE_ARTIFACT_BYTES,
    false,
  );
  const outputLimit = terminal.commandPlan.expectedOutputs[0]?.maxBytes ?? MAX_NATIVE_ARTIFACT_BYTES;
  const raw = detachedBytes(draft.rawBytes, outputLimit, true);
  const stdout = detachedBytes(draft.stdoutBytes, terminal.commandPlan.maxStdoutBytes, true);
  const stderr = detachedBytes(draft.stderrBytes, terminal.commandPlan.maxStderrBytes, true);
  if (
    !same(rejection.runtimeBinding, runtimeBinding) ||
    !same(rejection.rejectionIdentity, rejectedOperation.privateRejectionIdentity) ||
    !same(invocationInputSource.identity, runtimeMetadata.invocationInputSourceIdentity) ||
    !same(stdout.identity, rejection.stdoutIdentity) ||
    !same(stderr.identity, rejection.stderrIdentity) ||
    !same(rejection.sourceContentIdentity, source.bytes.length === 0 ? null : source.identity) ||
    !same(rejection.rawContentIdentity, raw.bytes.length === 0 ? null : raw.identity) ||
    rejection.processOutcome !== terminal.outcome ||
    rejection.exitCode !== terminal.exitCode
  ) {
    fail("Detached private rejection does not reproduce its bytes, W08 record, or public commitment.");
  }
};

/**
 * Independent private-aware consumer. Public structure is validated first,
 * then every operation is replayed or matched to its exact private rejection.
 */
export const consumeKicadBackendResultV3 = (
  value: unknown,
  requestValue: unknown,
  privateDraftsValue: readonly unknown[],
): KicadBackendResultV3 => {
  const request = validateKicadBackendRequestV3(requestValue);
  const result = validateKicadBackendResultV3(value, request);
  if (
    !Array.isArray(privateDraftsValue) ||
    privateDraftsValue.length !== result.operations.length
  ) {
    return fail("KiCad v3 independent consumption requires exactly one private draft per operation.");
  }
  const seen = new Set<string>();
  for (const [index, publicOperation] of result.operations.entries()) {
    const requestBinding = request.operationBindings[index]!;
    const draft = privateDraftsValue[index];
    const key = publicOperation.commandKind;
    if (seen.has(key)) return fail("KiCad v3 independent consumer received duplicate private drafts.");
    seen.add(key);
    if (publicOperation.status === "private_runtime_rejected") {
      consumeRejectionDraft(publicOperation, draft, requestBinding, request.executionContext);
    } else {
      consumeCaptureDraft(publicOperation, draft, requestBinding, request.executionContext);
    }
  }
  return result;
};

export class PortableKicadProducerV3 implements PortableKicadGenerationBackendV3 {
  public readonly backendId = "evleda.portable-kicad-producer.v3" as const;
  readonly #runner: BoundedProcessRunner;
  readonly #now: () => string;

  public constructor(options: PortableKicadProducerV3Options = {}) {
    this.#runner = options.runner ?? runBoundedProcess;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async execute(
    executionValue: PortableKicadProducerExecutionRequestV3,
  ): Promise<PortableKicadProducerExecutionV3> {
    const executionRecord = exactRecord(executionValue, [
      "publicRequest", "normalizer", "operations",
    ], "Portable KiCad v3 execution request");
    if (!Array.isArray(executionRecord.operations)) {
      return fail("Portable KiCad v3 private operations must be an array.");
    }
    const execution = executionRecord as unknown as PortableKicadProducerExecutionRequestV3;
    const request = validateKicadBackendRequestV3(execution.publicRequest);
    const normalizer = validateToolContentIdentityV1(execution.normalizer, "$execution/normalizer");
    if (normalizer.role !== "portable_normalizer" || normalizer.kind !== "portable_implementation") {
      return fail("Portable KiCad v3 requires an exact portable-normalizer identity.");
    }
    if (
      execution.operations.length !== request.operationBindings.length ||
      new Set(execution.operations.map((operation) => operation.commandKind)).size !== execution.operations.length
    ) {
      return fail("Private KiCad operation set does not match the public v3 request.");
    }
    const validatedOperations = request.operationBindings.map((binding) => {
      const operation = execution.operations.find(
        (candidate) => candidate.commandKind === binding.commandKind,
      );
      if (operation === undefined) return fail("KiCad v3 request operation is missing from private execution.");
      return validatePrivateOperation(operation, request);
    });
    const sourcePaths = validatedOperations.map((operation) => {
      const source = operation.plan.command.kind === "portable_typed_command_v1"
        ? operation.plan.command.value.argv.at(-1)
        : undefined;
      return source?.kind === "path"
        ? `${source.value.root}/${source.value.relativePath}`
        : fail("KiCad v3 source path is missing.");
    });
    if (new Set(sourcePaths).size !== sourcePaths.length) {
      return fail("Each KiCad v3 operation requires its own command-specific source snapshot.");
    }
    const preparedOperations = await prepareAllOperations(validatedOperations);

    const publicOperations: KicadPortableOperationResultV3[] = [];
    const privateDrafts: DetachedPrivateKicadOperationDraftV3[] = [];
    for (const prepared of preparedOperations) {
      const result = await executeOne(prepared, request, normalizer, this.#runner, this.#now);
      publicOperations.push(result.publicResult);
      privateDrafts.push(result.privateDraft);
    }
    const preimage = Object.freeze({
      schemaVersion: RESULT_SCHEMA,
      stage: request.stage,
      sourceRevisionDigest: request.expectedSourceRevisionDigest,
      requestIdentity: request.requestIdentity,
      operations: Object.freeze(publicOperations),
      lifecycle: "candidate" as const,
      hostAuthenticated: false as const,
      manufactureReady: false as const,
      qualificationAuthorized: false as const,
      releaseAuthorized: false as const,
    });
    const publicResult = consumeKicadBackendResultV3({
      ...preimage,
      resultIdentity: portableCanonicalIdentity(preimage, RESULT_SCHEMA),
    }, request, privateDrafts);
    return Object.freeze({
      publicResult,
      privateDrafts: Object.freeze(privateDrafts),
    });
  }
}

export const createPortableKicadProducerV3 = (
  options: PortableKicadProducerV3Options = {},
): PortableKicadProducerV3 => new PortableKicadProducerV3(options);

export type {
  PortablePdfNotRunV2,
  PrivateRawCaptureReceiptV2,
  PublicPortableSemanticsV2,
  RawBoundPortableReceiptV2,
};
